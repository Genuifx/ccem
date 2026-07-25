use super::*;
use crate::channel::{ChannelKind, OutputChannel};
use crate::event_bus::TerminalPromptKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TelegramChannelMode {
    Headless,
    Interactive,
}

struct TelegramChannelState {
    last_flush_at: Instant,
    last_event_seq: u64,
    pending_stdout: Vec<String>,
    pending_stderr: Vec<String>,
    pending_lines: Vec<String>,
    announced_requests: HashSet<String>,
    announced_responses: HashSet<String>,
    permission_messages: HashMap<String, TelegramSentMessage>,
    approval_message: Option<TelegramSentMessage>,
}

impl Default for TelegramChannelState {
    fn default() -> Self {
        Self {
            last_flush_at: Instant::now(),
            last_event_seq: 0,
            pending_stdout: Vec::new(),
            pending_stderr: Vec::new(),
            pending_lines: Vec::new(),
            announced_requests: HashSet::new(),
            announced_responses: HashSet::new(),
            permission_messages: HashMap::new(),
            approval_message: None,
        }
    }
}

pub struct TelegramChannel {
    manager: Arc<TelegramBridgeManager>,
    token: String,
    settings: TelegramSettings,
    runtime_id: String,
    chat_id: i64,
    thread_id: Option<i64>,
    mode: TelegramChannelMode,
    connected_at: DateTime<Utc>,
    state: Mutex<TelegramChannelState>,
}

impl TelegramChannel {
    pub fn headless(
        manager: Arc<TelegramBridgeManager>,
        token: String,
        settings: TelegramSettings,
        runtime_id: String,
        chat_id: i64,
        thread_id: Option<i64>,
    ) -> Self {
        Self {
            manager,
            token,
            settings,
            runtime_id,
            chat_id,
            thread_id,
            mode: TelegramChannelMode::Headless,
            connected_at: Utc::now(),
            state: Mutex::new(TelegramChannelState::default()),
        }
    }

    pub fn interactive(
        manager: Arc<TelegramBridgeManager>,
        token: String,
        settings: TelegramSettings,
        runtime_id: String,
        chat_id: i64,
        thread_id: Option<i64>,
    ) -> Self {
        Self {
            manager,
            token,
            settings,
            runtime_id,
            chat_id,
            thread_id,
            mode: TelegramChannelMode::Interactive,
            connected_at: Utc::now(),
            state: Mutex::new(TelegramChannelState::default()),
        }
    }

    pub fn flush_if_due(&self, force: bool) {
        let flush_interval =
            Duration::from_millis(self.settings.preferences.flush_interval_ms.max(500));

        match self.mode {
            TelegramChannelMode::Headless => {
                let (stdout, stderr) = {
                    let Ok(mut state) = self.state.lock() else {
                        return;
                    };
                    if state.pending_stdout.is_empty() && state.pending_stderr.is_empty() {
                        return;
                    }
                    if !force && state.last_flush_at.elapsed() < flush_interval {
                        return;
                    }
                    state.last_flush_at = Instant::now();
                    (
                        std::mem::take(&mut state.pending_stdout).join("\n"),
                        std::mem::take(&mut state.pending_stderr).join("\n"),
                    )
                };

                let message = format_headless_turn_message(&self.runtime_id, &stdout, &stderr);
                let _ = send_message(&self.token, self.chat_id, self.thread_id, &message);
            }
            TelegramChannelMode::Interactive => {
                let body = {
                    let Ok(mut state) = self.state.lock() else {
                        return;
                    };
                    if state.pending_lines.is_empty() {
                        return;
                    }
                    if !force && state.last_flush_at.elapsed() < flush_interval {
                        return;
                    }
                    state.last_flush_at = Instant::now();
                    truncate_for_telegram(&std::mem::take(&mut state.pending_lines).join("\n\n"))
                };

                let _ = send_message(&self.token, self.chat_id, self.thread_id, &body);
            }
        }
    }

    fn mark_event_seen(&self, seq: u64) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if seq <= state.last_event_seq {
            return false;
        }
        state.last_event_seq = seq;
        true
    }

    fn handle_headless_event(
        &self,
        event: &crate::event_bus::SessionEventRecord,
    ) -> Result<(), String> {
        let mut should_flush = false;
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Failed to lock Telegram channel state".to_string())?;
            match &event.payload {
                SessionEventPayload::AssistantChunk { text } if !text.trim().is_empty() => {
                    state.pending_stdout.push(text.clone());
                }
                SessionEventPayload::StdErrLine { line } if !line.trim().is_empty() => {
                    state.pending_stderr.push(line.clone());
                }
                SessionEventPayload::Lifecycle { stage, detail } => {
                    if matches!(
                        stage.as_str(),
                        "stderr_error" | "stdout_error" | "process_failure"
                    ) {
                        state.pending_stderr.push(format!("[{stage}] {detail}"));
                    }
                }
                SessionEventPayload::PermissionRequired {
                    request_id,
                    tool_name,
                    ..
                } if state.announced_requests.insert(request_id.clone()) => {
                    if let Ok(sent_message) = send_permission_request_message(
                        &self.token,
                        self.chat_id,
                        self.thread_id,
                        request_id,
                        tool_name,
                    ) {
                        state
                            .permission_messages
                            .insert(request_id.clone(), sent_message);
                    }
                }
                SessionEventPayload::PermissionResponded {
                    request_id,
                    approved,
                    responder,
                    ..
                } if state.announced_responses.insert(request_id.clone()) => {
                    let text = format_permission_response_text(request_id, *approved, responder);
                    if let Some(sent_message) = state.permission_messages.remove(request_id) {
                        if edit_message_text(
                            &self.token,
                            self.chat_id,
                            sent_message.message_id,
                            &text,
                            None,
                        )
                        .is_err()
                        {
                            let _ = send_message(&self.token, self.chat_id, self.thread_id, &text);
                        }
                    } else {
                        let _ = send_message(&self.token, self.chat_id, self.thread_id, &text);
                    }
                }
                SessionEventPayload::ClaudeJson {
                    message_type,
                    raw_json,
                } if message_type.as_deref() == Some("result") => {
                    let result = parse_headless_result_payload(raw_json);
                    if state.pending_stdout.is_empty() {
                        if let Some(text) = result
                            .as_ref()
                            .and_then(|payload| payload.result_text.as_deref())
                            .filter(|text| !text.trim().is_empty())
                            .filter(|_| !result.as_ref().is_some_and(|payload| payload.is_error))
                        {
                            state.pending_stdout.push(text.to_string());
                        }
                    }
                    if state.pending_stderr.is_empty() {
                        if let Some(text) = result
                            .as_ref()
                            .and_then(|payload| payload.result_text.as_deref())
                            .filter(|text| !text.trim().is_empty())
                            .filter(|_| result.as_ref().is_some_and(|payload| payload.is_error))
                        {
                            state.pending_stderr.push(text.to_string());
                        }
                    }
                    should_flush = true;
                }
                SessionEventPayload::SessionCompleted { reason }
                    if reason != "completed" && reason != "stopped" =>
                {
                    state.pending_stderr.push(reason.clone());
                }
                _ => {}
            }
        }

        self.flush_if_due(should_flush);
        Ok(())
    }

    fn handle_interactive_event(
        &self,
        event: &crate::event_bus::SessionEventRecord,
    ) -> Result<(), String> {
        let mut should_flush = false;
        match &event.payload {
            SessionEventPayload::AssistantChunk { text } if !text.trim().is_empty() => {
                if let Ok(mut state) = self.state.lock() {
                    state.pending_lines.push(text.clone());
                }
            }
            SessionEventPayload::SystemMessage { message } if !message.trim().is_empty() => {
                if let Ok(mut state) = self.state.lock() {
                    state.pending_lines.push(message.clone());
                }
            }
            SessionEventPayload::ToolUseStarted {
                tool_use_id,
                category,
                raw_name,
                input_summary,
                needs_response,
                prompt,
                ..
            } => {
                if !self.manager.mark_interactive_tool_seen(
                    self.chat_id,
                    self.thread_id,
                    tool_use_id,
                ) {
                    return Ok(());
                }

                if *needs_response {
                    match prompt.clone() {
                        Some(InteractiveToolPrompt::AskUserQuestion { questions })
                            if !questions.is_empty() =>
                        {
                            let questions = normalize_ask_user_questions_for_telegram(questions);
                            let prompt_state = ActiveInteractiveChoicePrompt {
                                runtime_id: self.runtime_id.clone(),
                                tool_use_id: tool_use_id.clone(),
                                questions,
                                current_question_index: 0,
                                submit_mode: InteractiveChoiceSubmitMode::AskUserQuestion,
                                selected_options: BTreeSet::new(),
                                awaiting_text_entry: None,
                                message_id: None,
                            };
                            let text = format_active_choice_text(&prompt_state);
                            let markup = build_active_choice_markup(&prompt_state);
                            if let Ok(sent) = send_message_with_markup(
                                &self.token,
                                self.chat_id,
                                self.thread_id,
                                &text,
                                Some(markup),
                            ) {
                                let mut prompt_state = prompt_state;
                                prompt_state.message_id = Some(sent.message_id);
                                self.manager.remember_active_prompt(
                                    self.chat_id,
                                    self.thread_id,
                                    ActiveInteractivePrompt::Choice(prompt_state),
                                );
                            }
                        }
                        Some(InteractiveToolPrompt::PlanExit {
                            allowed_prompts,
                            plan_summary,
                        }) => {
                            let question = build_plan_exit_question(
                                plan_summary
                                    .as_deref()
                                    .or((!input_summary.trim().is_empty())
                                        .then_some(input_summary.as_str())),
                                &allowed_prompts,
                            );
                            let prompt_state = ActiveInteractiveChoicePrompt {
                                runtime_id: self.runtime_id.clone(),
                                tool_use_id: tool_use_id.clone(),
                                questions: vec![question],
                                current_question_index: 0,
                                submit_mode: InteractiveChoiceSubmitMode::PlanExit,
                                selected_options: BTreeSet::new(),
                                awaiting_text_entry: None,
                                message_id: None,
                            };
                            let text = format_active_choice_text(&prompt_state);
                            let markup = build_active_choice_markup(&prompt_state);
                            if let Ok(sent) = send_message_with_markup(
                                &self.token,
                                self.chat_id,
                                self.thread_id,
                                &truncate_for_telegram(&text),
                                Some(markup),
                            ) {
                                let mut prompt_state = prompt_state;
                                prompt_state.message_id = Some(sent.message_id);
                                self.manager.remember_active_prompt(
                                    self.chat_id,
                                    self.thread_id,
                                    ActiveInteractivePrompt::Choice(prompt_state),
                                );
                            }
                        }
                        _ => {
                            if let Ok(mut state) = self.state.lock() {
                                state
                                    .pending_lines
                                    .push(format!("🔧 {}: {}", raw_name, input_summary));
                            }
                        }
                    }
                } else {
                    if matches!(prompt, Some(InteractiveToolPrompt::PlanEntry)) {
                        if let Ok(mut state) = self.state.lock() {
                            state
                                .pending_lines
                                .push("🧭 Claude entered plan mode.".to_string());
                        }
                    }
                    if self.settings.preferences.show_tool_calls {
                        if let Some(message) =
                            format_tool_started_message(category, raw_name, input_summary)
                        {
                            if let Ok(mut state) = self.state.lock() {
                                state.pending_lines.push(message);
                            }
                        }
                    }
                }
            }
            SessionEventPayload::ToolUseCompleted {
                tool_use_id,
                raw_name,
                result_summary,
                success,
                ..
            } => {
                if let Some(active_prompt) = self
                    .manager
                    .active_prompt_for_scope(self.chat_id, self.thread_id)
                {
                    let (matches_active, message_id) = match active_prompt {
                        ActiveInteractivePrompt::Choice(prompt) => {
                            (prompt.tool_use_id == *tool_use_id, prompt.message_id)
                        }
                    };

                    if matches_active {
                        self.manager
                            .clear_active_prompt_for_scope(self.chat_id, self.thread_id);
                        if let Some(message_id) = message_id {
                            let final_text =
                                summarize_interactive_prompt_resolution(raw_name, result_summary);
                            let _ = edit_message_text(
                                &self.token,
                                self.chat_id,
                                message_id,
                                &truncate_for_telegram(&final_text),
                                None,
                            );
                        }
                    }
                }

                if self.settings.preferences.show_tool_calls {
                    if let Some(message) =
                        format_tool_completed_message(raw_name, result_summary, *success)
                    {
                        if let Ok(mut state) = self.state.lock() {
                            state.pending_lines.push(message);
                        }
                    }
                }
            }
            SessionEventPayload::TerminalPromptRequired {
                prompt_kind: TerminalPromptKind::Permission,
                ..
            } => {
                if let Ok(mut state) = self.state.lock() {
                    if state.approval_message.is_none() {
                        if let Ok(sent) = send_interactive_permission_request_message(
                            &self.token,
                            self.chat_id,
                            self.thread_id,
                            &self.runtime_id,
                        ) {
                            state.approval_message = Some(sent);
                        }
                    }
                }
            }
            SessionEventPayload::TerminalPromptResolved {
                prompt_kind: TerminalPromptKind::Permission,
                ..
            } => {
                if let Ok(mut state) = self.state.lock() {
                    if let Some(sent) = state.approval_message.take() {
                        let _ = edit_message_text(
                            &self.token,
                            self.chat_id,
                            sent.message_id,
                            "Interactive approval request resolved.",
                            None,
                        );
                    }
                }
            }
            SessionEventPayload::SessionCompleted { .. } => {
                should_flush = true;
            }
            _ => {}
        }

        self.flush_if_due(should_flush);
        Ok(())
    }
}

impl OutputChannel for TelegramChannel {
    fn channel_kind(&self) -> ChannelKind {
        ChannelKind::Telegram {
            chat_id: self.chat_id,
            thread_id: self.thread_id,
        }
    }

    fn connected_at(&self) -> DateTime<Utc> {
        self.connected_at
    }

    fn label(&self) -> Option<String> {
        self.thread_id
            .map(|thread_id| format!("Telegram #{thread_id}"))
            .or_else(|| Some("Telegram".to_string()))
    }

    fn send_event(&self, event: &crate::event_bus::SessionEventRecord) -> Result<(), String> {
        if !self.mark_event_seen(event.seq) {
            return Ok(());
        }
        match self.mode {
            TelegramChannelMode::Headless => self.handle_headless_event(event),
            TelegramChannelMode::Interactive => self.handle_interactive_event(event),
        }
    }

    fn is_connected(&self) -> bool {
        !self.manager.stop_flag.load(Ordering::SeqCst)
    }
}
