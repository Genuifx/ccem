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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationLanguage {
    Zh,
    En,
}

fn notification_language(settings: &DesktopSettings) -> NotificationLanguage {
    match settings
        .language
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "en" => NotificationLanguage::En,
        _ => NotificationLanguage::Zh,
    }
}

fn localized_text(
    language: NotificationLanguage,
    zh: &'static str,
    en: &'static str,
) -> &'static str {
    match language {
        NotificationLanguage::Zh => zh,
        NotificationLanguage::En => en,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NotificationPrefs {
    enabled: bool,
    task_completed: bool,
    task_failed: bool,
    action_required: bool,
    language: NotificationLanguage,
}

impl NotificationPrefs {
    fn disabled() -> Self {
        Self {
            enabled: false,
            task_completed: false,
            task_failed: false,
            action_required: false,
            language: NotificationLanguage::Zh,
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
            language: notification_language(settings),
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

    pub fn replace_preferences_from_settings(&self, settings: &DesktopSettings) {
        if let Ok(mut prefs) = self.prefs.write() {
            prefs.enabled = settings.desktop_notifications_enabled;
            prefs.task_completed = settings.notify_on_task_completed;
            prefs.task_failed = settings.notify_on_task_failed;
            prefs.action_required = settings.notify_on_action_required;
        }
    }

    pub fn replace_language_from_settings(&self, settings: &DesktopSettings) {
        if let Ok(mut prefs) = self.prefs.write() {
            prefs.language = notification_language(settings);
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

fn action_prompt_body(
    language: NotificationLanguage,
    prompt: Option<&InteractiveToolPrompt>,
) -> Option<String> {
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
                .unwrap_or_else(|| {
                    localized_text(
                        language,
                        "计划已准备好，等待确认。",
                        "A plan is ready for review.",
                    )
                    .to_string()
                }),
        ),
        _ => None,
    }
}

fn build_task_completed_draft(
    context: &NotificationContext,
    language: NotificationLanguage,
) -> NotificationDraft {
    NotificationDraft {
        kind: NotificationKind::TaskCompleted,
        title: match language {
            NotificationLanguage::Zh => format!("{} 任务已完成", context.client_name),
            NotificationLanguage::En => format!("{} task completed", context.client_name),
        },
        body: match language {
            NotificationLanguage::Zh => format!(
                "{} 已在 {} 完成",
                project_label(&context.project_dir),
                context.env_name,
            ),
            NotificationLanguage::En => format!(
                "{} finished in {}",
                project_label(&context.project_dir),
                context.env_name,
            ),
        },
    }
}

fn build_task_failed_draft(
    context: &NotificationContext,
    language: NotificationLanguage,
    detail: impl Into<String>,
) -> NotificationDraft {
    NotificationDraft {
        kind: NotificationKind::TaskFailed,
        title: match language {
            NotificationLanguage::Zh => format!("{} 任务需要处理", context.client_name),
            NotificationLanguage::En => format!("{} task needs attention", context.client_name),
        },
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
    language: NotificationLanguage,
) -> Option<NotificationDraft> {
    match payload {
        SessionEventPayload::SessionCompleted { reason } => match reason.as_str() {
            "completed" => Some(build_task_completed_draft(context, language)),
            "stopped" => None,
            _ => Some(build_task_failed_draft(
                context,
                language,
                match language {
                    NotificationLanguage::Zh => format!(
                        "{} 在 {} 失败：{}",
                        project_label(&context.project_dir),
                        context.env_name,
                        reason,
                    ),
                    NotificationLanguage::En => format!(
                        "{} failed in {}: {}",
                        project_label(&context.project_dir),
                        context.env_name,
                        reason,
                    ),
                },
            )),
        },
        SessionEventPayload::PermissionRequired { tool_name, .. } => {
            Some(build_action_required_draft(
                context,
                localized_text(language, "需要审批", "Approval required"),
                match language {
                    NotificationLanguage::Zh => format!(
                        "{} 在 {} 需要审批才能继续（{}）",
                        context.client_name,
                        project_label(&context.project_dir),
                        tool_name,
                    ),
                    NotificationLanguage::En => format!(
                        "{} needs approval to continue in {} ({})",
                        context.client_name,
                        project_label(&context.project_dir),
                        tool_name,
                    ),
                },
            ))
        }
        SessionEventPayload::TerminalPromptRequired { prompt_text, .. } => {
            Some(build_action_required_draft(
                context,
                localized_text(language, "需要审批", "Approval required"),
                match language {
                    NotificationLanguage::Zh => format!(
                        "{} 正在 {} 等待：{}",
                        context.client_name,
                        project_label(&context.project_dir),
                        prompt_text,
                    ),
                    NotificationLanguage::En => format!(
                        "{} is waiting in {}: {}",
                        context.client_name,
                        project_label(&context.project_dir),
                        prompt_text,
                    ),
                },
            ))
        }
        SessionEventPayload::ToolUseStarted {
            needs_response,
            prompt,
            ..
        } if *needs_response => {
            let (title, body) = match prompt {
                Some(InteractiveToolPrompt::PlanExit { .. }) => (
                    localized_text(language, "需要确认计划", "Plan review required"),
                    action_prompt_body(language, prompt.as_ref()).unwrap_or_else(
                        || match language {
                            NotificationLanguage::Zh => format!(
                                "{} 正在 {} 等待反馈",
                                context.client_name,
                                project_label(&context.project_dir),
                            ),
                            NotificationLanguage::En => format!(
                                "{} is waiting for feedback in {}",
                                context.client_name,
                                project_label(&context.project_dir),
                            ),
                        },
                    ),
                ),
                _ => (
                    localized_text(language, "需要输入", "Input required"),
                    action_prompt_body(language, prompt.as_ref()).unwrap_or_else(
                        || match language {
                            NotificationLanguage::Zh => format!(
                                "{} 正在 {} 等待输入",
                                context.client_name,
                                project_label(&context.project_dir),
                            ),
                            NotificationLanguage::En => format!(
                                "{} is waiting for input in {}",
                                context.client_name,
                                project_label(&context.project_dir),
                            ),
                        },
                    ),
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
    let prefs = load_prefs(app);
    let Some(draft) = build_session_event_draft(context, payload, prefs.language) else {
        return;
    };

    if should_send(&prefs, &draft) {
        let _ = show_notification(app, &draft);
    }
}

pub fn maybe_notify_task_completed<R: Runtime>(app: &AppHandle<R>, context: &NotificationContext) {
    let prefs = load_prefs(app);
    let draft = build_task_completed_draft(context, prefs.language);
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
    let draft = build_task_failed_draft(context, prefs.language, detail);
    if should_send(&prefs, &draft) {
        let _ = show_notification(app, &draft);
    }
}

pub fn send_test_notification<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let prefs = load_prefs(app);
    show_notification(
        app,
        &NotificationDraft {
            kind: NotificationKind::ActionRequired,
            title: localized_text(
                prefs.language,
                "CCEM 通知已准备就绪",
                "CCEM notifications are ready",
            )
            .to_string(),
            body: localized_text(
                prefs.language,
                "任务完成和反馈提示会显示在这里。",
                "Task completion and feedback prompts will show up here.",
            )
            .to_string(),
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
            language: NotificationLanguage::En,
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
            NotificationLanguage::En,
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
            NotificationLanguage::En,
        );

        assert!(draft.is_none());
    }

    #[test]
    fn question_prompt_maps_to_action_required_notification() {
        let payload = SessionEventPayload::ToolUseStarted {
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
        };
        let english = build_session_event_draft(&context(), &payload, NotificationLanguage::En)
            .expect("expected English action notification");
        let chinese = build_session_event_draft(&context(), &payload, NotificationLanguage::Zh)
            .expect("expected Chinese action notification");

        assert_eq!(english.kind, NotificationKind::ActionRequired);
        assert_eq!(english.title, "Input required");
        assert!(english.body.contains("Deployment window"));
        assert_eq!(chinese.title, "需要输入");
        assert!(chinese.body.contains("Deployment window"));
    }

    #[test]
    fn approval_prompt_uses_localized_title_and_body() {
        let payload = SessionEventPayload::PermissionRequired {
            request_id: "req-1".to_string(),
            tool_use_id: None,
            tool_name: "Bash".to_string(),
            input_summary: None,
        };
        let english = build_session_event_draft(&context(), &payload, NotificationLanguage::En)
            .expect("expected English approval notification");
        let chinese = build_session_event_draft(&context(), &payload, NotificationLanguage::Zh)
            .expect("expected Chinese approval notification");

        assert_eq!(english.title, "Approval required");
        assert_eq!(
            english.body,
            "Claude needs approval to continue in demo-project (Bash)"
        );
        assert_eq!(chinese.title, "需要审批");
        assert_eq!(
            chinese.body,
            "Claude 在 demo-project 需要审批才能继续（Bash）"
        );
    }

    #[test]
    fn plan_review_prompt_uses_localized_title_and_fallback() {
        let payload = SessionEventPayload::ToolUseStarted {
            tool_use_id: "tool-plan".to_string(),
            category: ToolCategory::UserInput {
                kind: UserInputKind::PlanExit,
                raw_name: "exit_plan_mode".to_string(),
            },
            raw_name: "exit_plan_mode".to_string(),
            input_summary: "plan ready".to_string(),
            needs_response: true,
            prompt: Some(InteractiveToolPrompt::PlanExit {
                allowed_prompts: Vec::new(),
                plan_summary: None,
            }),
            todo_snapshot: None,
        };
        let english = build_session_event_draft(&context(), &payload, NotificationLanguage::En)
            .expect("expected English plan notification");
        let chinese = build_session_event_draft(&context(), &payload, NotificationLanguage::Zh)
            .expect("expected Chinese plan notification");

        assert_eq!(english.title, "Plan review required");
        assert_eq!(english.body, "A plan is ready for review.");
        assert_eq!(chinese.title, "需要确认计划");
        assert_eq!(chinese.body, "计划已准备好，等待确认。");
    }

    #[test]
    fn unknown_language_falls_back_to_chinese() {
        let settings = DesktopSettings {
            language: Some("fr".to_string()),
            ..DesktopSettings::default()
        };

        assert_eq!(notification_language(&settings), NotificationLanguage::Zh);
    }

    #[test]
    fn missing_language_falls_back_to_chinese_during_legacy_migration() {
        assert_eq!(
            notification_language(&DesktopSettings::default()),
            NotificationLanguage::Zh
        );
    }

    #[test]
    fn language_and_generic_preference_updates_do_not_overwrite_each_other() {
        let state = NotificationPrefsState {
            prefs: RwLock::new(enabled_prefs()),
        };
        let generic_update = DesktopSettings {
            desktop_notifications_enabled: false,
            language: Some("zh".to_string()),
            ..DesktopSettings::default()
        };
        state.replace_preferences_from_settings(&generic_update);
        assert!(!state.snapshot().enabled);
        assert_eq!(state.snapshot().language, NotificationLanguage::En);

        let language_update = DesktopSettings {
            language: Some("zh".to_string()),
            desktop_notifications_enabled: true,
            ..DesktopSettings::default()
        };
        state.replace_language_from_settings(&language_update);
        assert!(!state.snapshot().enabled);
        assert_eq!(state.snapshot().language, NotificationLanguage::Zh);
    }

    #[test]
    fn disabled_master_toggle_blocks_notification() {
        let mut prefs = enabled_prefs();
        prefs.enabled = false;

        let draft = build_task_completed_draft(&context(), NotificationLanguage::En);
        assert!(!should_send(&prefs, &draft));
    }
}
