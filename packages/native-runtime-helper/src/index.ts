import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildClaudeQueryEnv } from './claudeEnv';
import { applyClaudePermissionModeToQuery } from './claudePermissionControl';
import { resolveClaudePermissionRequestId, type ClaudeToolPermissionOptions } from './claudePermissionRequests';
import { QuerySnapshotSlot, type QuerySnapshot } from './claudeQuerySnapshotSlot';
import { buildClaudePlanModeHooks } from './claudePlanGuard';
import {
  createBrowserToolBridge,
  createCcemBrowserMcpServer,
  ensureBrowserMcpToolsAllowed,
  isBrowserEvaluateToolName,
  type BrowserToolRequestOutput,
  type BrowserToolResponseCommand,
} from './browserMcp';
import {
  CLAUDE_SKILL_SETTING_SOURCES,
  ensureClaudeSkillToolAllowed,
} from './claudeSkills';
import { buildPromptContentParts, type PromptImage } from './promptContent';
import { normalizeClaudePermissionMode, normalizeCodexSandboxMode } from './permissionModes';
import { createLocalImageInputs, cleanupTempFiles } from './imageInputs';
import {
  buildCodexContextUsageFromTokenCount,
  findCodexSessionFile,
  readLatestCodexContextUsageFromSessionFile,
} from './codexContextUsage';
import { buildClaudeFileCheckpointEvent } from './claudeFileCheckpoints';
import { TodoSnapshotTracker, type TodoSnapshotV1 } from './todoSnapshots';
import { formatPermissionPreview } from './permissionPreview';

type NativeProvider = 'claude' | 'codex';

type InitCommand = {
  type: 'init';
  provider: NativeProvider;
  env_name: string;
  perm_mode: string;
  allow_dangerously_skip_permissions?: boolean;
  working_dir: string;
  env_vars?: Record<string, string>;
  initial_prompt?: string | null;
  initial_images?: PromptImage[] | null;
  provider_session_id?: string | null;
  claude_path?: string | null;
  codex_path?: string | null;
  codex_base_url?: string | null;
  codex_api_key?: string | null;
  effort?: string | null;
  allowed_tools?: string[] | null;
  disallowed_tools?: string[] | null;
  todo_snapshot_seed?: TodoSnapshotV1 | null;
};

type PromptCommand = {
  type: 'prompt';
  text: string;
  images?: PromptImage[] | null;
};

type InteractivePromptResponseCommand = {
  type: 'interactive_prompt_response';
  tool_use_id: string;
  prompt_type: 'ask_user_question' | 'plan_exit';
  answers: Record<string, string>;
  annotations?: Record<string, {
    preview?: string;
    notes?: string;
  }>;
};

type PermissionResponseCommand = {
  type: 'permission_response';
  request_id: string;
  approved: boolean;
};

type BrowserToolResponseInputCommand = BrowserToolResponseCommand;

type UpdateSettingsCommand = {
  type: 'update_settings';
  env_name?: string;
  perm_mode?: string;
  env_vars?: Record<string, string>;
  effort?: string;
};

type RewindFilesCommand = {
  type: 'rewind_files';
  checkpoint_id: string;
};

type TitleQueryCommand = {
  type: 'title_query';
  title_input: string;
  working_dir: string;
  env_vars?: Record<string, string>;
  claude_path?: string | null;
  model?: string | null;
  effort?: string | null;
};

type RuntimeSettingsPatch = {
  envName?: string;
  permMode?: string;
  envVars?: Record<string, string>;
  effort?: string;
};

type StopCommand = {
  type: 'stop';
};

type InputCommand =
  | InitCommand
  | PromptCommand
  | InteractivePromptResponseCommand
  | PermissionResponseCommand
  | BrowserToolResponseInputCommand
  | UpdateSettingsCommand
  | RewindFilesCommand
  | TitleQueryCommand
  | StopCommand;

type ClaudePermissionRequestOptions = ClaudeToolPermissionOptions & {
  title?: string;
  description?: string;
  displayName?: string;
  blockedPath?: string;
  decisionReason?: string;
};

type HelperOutput =
  | {
      type: 'event';
      payload: Record<string, unknown>;
    }
  | {
      type: 'session_meta';
      provider_session_id: string;
    }
  | {
      type: 'status';
      status: string;
      detail?: string;
    }
  | {
      type: 'title_result';
      title: string | null;
    }
  | BrowserToolRequestOutput;

type PermissionResolver = {
  resolve: (approved: boolean) => void;
};

type ClaudeInteractivePromptResolver = {
  input: Record<string, unknown>;
  resolve: (result: {
    behavior: 'allow';
    updatedInput: Record<string, unknown>;
    toolUseID: string;
  } | {
    behavior: 'deny';
    message: string;
    toolUseID: string;
  }) => void;
};

const DEFAULT_CLAUDE_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS = 8_000;
const CLAUDE_INCOMPLETE_RESPONSE_REASON = 'Claude response ended before a final result. Partial output was preserved; send the next prompt to retry.';

let initCommand: InitCommand | null = null;
let stopped = false;
let activeTurn = false;
let currentProviderSessionId: string | null = null;
let currentAbortController: AbortController | null = null;
let currentClaudeQuery: ReturnType<typeof query> | null = null;
let claudeInputQueue: AsyncMessageQueue<SDKUserMessage> | null = null;
const claudeQuerySlot = new QuerySnapshotSlot<
  ReturnType<typeof query>,
  AsyncMessageQueue<SDKUserMessage>
>();
let claudeConsumeLoop: Promise<void> | null = null;
let claudeIdleCloseTimer: ReturnType<typeof setTimeout> | null = null;
let claudeLastSessionState: 'idle' | 'running' | 'requires_action' | null = null;
let claudeInterruptRequested = false;
let claudeInterruptCompletionEmitted = false;
let claudeSawPartialText = false;
let claudeSawPartialThinking = false;
let claudeTurnCompletionEmitted = false;
let claudeTurnAwaitingResult = false;
let pendingClaudePromptReplay: { text: string; images?: PromptImage[] | null } | null = null;
const claudeSeenMessageIds = new Set<string>();
let claudeContextUsageFailureKey: string | null = null;
let codexClient: Codex | null = null;
let codexThread: any = null;
let codexLastContextUsageKey: string | null = null;
let pendingSettings: RuntimeSettingsPatch | null = null;
const promptQueue: Array<{ text: string; images?: PromptImage[] | null }> = [];
const pendingPermissions = new Map<string, PermissionResolver>();
const pendingClaudeInteractivePrompts = new Map<string, ClaudeInteractivePromptResolver>();
const startedToolNames = new Map<string, string>();
const completedToolUseIds = new Set<string>();
const pendingClaudeToolInputs = new Map<string, Record<string, unknown>>();
const todoSnapshotTracker = new TodoSnapshotTracker();
const browserToolBridge = createBrowserToolBridge((request) => emit(request));
let browserEvaluateApprovedForSession = false;

type ClaudeQuerySnapshot = QuerySnapshot<ReturnType<typeof query>, AsyncMessageQueue<SDKUserMessage>>;

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T) {
    if (this.closed) {
      throw new Error('Message queue is closed');
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
      return;
    }

    this.items.push(item);
  }

  close() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()?.({ value: undefined as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }

      if (this.closed) {
        return;
      }

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve);
      });

      if (next.done) {
        return;
      }

      yield next.value;
    }
  }
}

function emit(output: HelperOutput) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function emitStatus(status: string, detail?: string) {
  emit({ type: 'status', status, detail });
}

function emitEvent(payload: Record<string, unknown>) {
  emit({ type: 'event', payload });
}

function emitSessionMeta(providerSessionId: string) {
  if (!providerSessionId) {
    return;
  }
  currentProviderSessionId = providerSessionId;
  emit({ type: 'session_meta', provider_session_id: providerSessionId });
}

function resolveClaudeIdleTtlMs() {
  const raw = process.env.CCEM_NATIVE_CLAUDE_IDLE_TTL_MS;
  if (raw == null || raw.trim() === '') {
    return DEFAULT_CLAUDE_IDLE_TTL_MS;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_CLAUDE_IDLE_TTL_MS;
}

function resolveClaudeInterruptTimeoutMs() {
  const raw = process.env.CCEM_NATIVE_CLAUDE_INTERRUPT_TIMEOUT_MS;
  if (raw == null || raw.trim() === '') {
    return DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (ms <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.name = 'TimeoutError';
          reject(error);
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function interruptClaudeWithTimeout(claudeQuery: ReturnType<typeof query>) {
  const timeoutMs = resolveClaudeInterruptTimeoutMs();
  return withTimeout(
    claudeQuery.interrupt(),
    timeoutMs,
    `Claude interrupt timed out after ${timeoutMs}ms`,
  );
}

function clearClaudeIdleCloseTimer() {
  if (claudeIdleCloseTimer) {
    clearTimeout(claudeIdleCloseTimer);
    claudeIdleCloseTimer = null;
  }
}

function captureCurrentClaudeQuerySnapshot(): ClaudeQuerySnapshot | null {
  return claudeQuerySlot.capture();
}

function isCurrentClaudeQuerySnapshot(snapshot: ClaudeQuerySnapshot | null | undefined) {
  return claudeQuerySlot.isCurrent(snapshot)
    && currentClaudeQuery === snapshot.query
    && claudeInputQueue === snapshot.inputQueue;
}

function clearCurrentClaudeQuerySnapshot(snapshot: ClaudeQuerySnapshot | null | undefined) {
  if (!claudeQuerySlot.clearIfCurrent(snapshot)) {
    return false;
  }

  currentClaudeQuery = null;
  claudeInputQueue = null;
  return true;
}

function clearAllClaudeQueryState() {
  claudeQuerySlot.clear();
  currentClaudeQuery = null;
  claudeInputQueue = null;
}

function closeClaudeQueryForRecovery(snapshot = captureCurrentClaudeQuerySnapshot()) {
  clearClaudeIdleCloseTimer();
  pendingClaudePromptReplay = null;

  if (!snapshot) {
    return;
  }

  if (isCurrentClaudeQuerySnapshot(snapshot)) {
    claudeTurnAwaitingResult = false;
  }

  const queueToClose = snapshot.inputQueue;
  const queryToClose = snapshot.query;

  if (queueToClose) {
    queueToClose.close();
    if (claudeInputQueue === queueToClose && isCurrentClaudeQuerySnapshot(snapshot)) {
      claudeInputQueue = null;
    }
  }

  queryToClose.close();
  clearCurrentClaudeQuerySnapshot(snapshot);
}

function shouldInterruptCurrentClaudeTurn(
  snapshot: ClaudeQuerySnapshot | null = captureCurrentClaudeQuerySnapshot(),
): snapshot is ClaudeQuerySnapshot {
  return snapshot !== null
    && isCurrentClaudeQuerySnapshot(snapshot)
    && !claudeTurnCompletionEmitted
    && claudeTurnAwaitingResult;
}

function scheduleClaudeIdleClose() {
  clearClaudeIdleCloseTimer();

  if (!currentClaudeQuery || !claudeInputQueue || initCommand?.provider !== 'claude') {
    return;
  }

  const ttlMs = resolveClaudeIdleTtlMs();
  if (ttlMs <= 0) {
    return;
  }

  const snapshotToClose = captureCurrentClaudeQuerySnapshot();
  if (!snapshotToClose || !snapshotToClose.inputQueue) {
    return;
  }

  const queryToClose = snapshotToClose.query;
  const queueToClose = snapshotToClose.inputQueue;
  claudeIdleCloseTimer = setTimeout(() => {
    claudeIdleCloseTimer = null;
    if (
      !isCurrentClaudeQuerySnapshot(snapshotToClose)
      || claudeInputQueue !== queueToClose
    ) {
      return;
    }
    if (!claudeTurnCompletionEmitted && !claudeInterruptCompletionEmitted) {
      return;
    }

    pendingClaudePromptReplay = null;
    queueToClose.close();
    queryToClose.close();
    if (
      isCurrentClaudeQuerySnapshot(snapshotToClose)
      && claudeInputQueue === queueToClose
    ) {
      clearCurrentClaudeQuerySnapshot(snapshotToClose);
    }
  }, ttlMs);
  claudeIdleCloseTimer.unref?.();
}

function toolCategory(rawName: string, category?: 'execution' | 'file_op' | 'search' | 'task_mgmt' | 'unknown') {
  const normalized = category ?? 'unknown';
  return {
    category: normalized,
    raw_name: rawName,
  };
}

function userInputToolCategory(rawName: string, kind: 'question' | 'plan_entry' | 'plan_exit') {
  return {
    category: 'user_input' as const,
    kind,
    raw_name: rawName,
  };
}

function isClaudeInteractiveUserInputTool(name: string) {
  return categorizeClaudeTool(name).category === 'user_input';
}

function summarizeUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateSummary(value: string, maxLength = 160): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function getClaudeContentBlocks(message: unknown): Array<Record<string, unknown>> {
  const content = (message as { content?: Array<Record<string, unknown>> } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content;
}

function extractClaudeAssistantContent(message: unknown): { text: string; thinking: string[] } {
  const content = getClaudeContentBlocks(message);

  const text: string[] = [];
  const thinking: string[] = [];

  content.forEach((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      text.push(block.text);
      return;
    }

    if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      thinking.push(block.thinking);
    }
  });

  return {
    text: text.join(''),
    thinking,
  };
}

function extractClaudeAssistantText(message: unknown): string {
  return extractClaudeAssistantContent(message).text;
}

function nonEmptyEnvValue(envVars: Record<string, string> | undefined, key: string) {
  const value = envVars?.[key]?.trim();
  return value ? value : undefined;
}

function resolveClaudeRuntimeModel(envVars?: Record<string, string>) {
  return nonEmptyEnvValue(envVars, 'ANTHROPIC_MODEL')
    || nonEmptyEnvValue(envVars, 'ANTHROPIC_DEFAULT_OPUS_MODEL')
    || nonEmptyEnvValue(envVars, 'ANTHROPIC_DEFAULT_SONNET_MODEL')
    || nonEmptyEnvValue(envVars, 'ANTHROPIC_DEFAULT_HAIKU_MODEL')
    || nonEmptyEnvValue(envVars, 'ANTHROPIC_SMALL_FAST_MODEL');
}

async function runWorkspaceTitleQuery(command: TitleQueryCommand) {
  const titleInput = command.title_input.trim();
  if (!titleInput) {
    emit({ type: 'title_result', title: null });
    return;
  }

  const env = buildClaudeQueryEnv({
    envVars: command.env_vars,
    effort: command.effort,
  });
  const model = command.model?.trim()
    || command.env_vars?.ANTHROPIC_MODEL?.trim()
    || command.env_vars?.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim()
    || command.env_vars?.ANTHROPIC_SMALL_FAST_MODEL?.trim()
    || 'haiku';
  const prompt = [
    '请根据下面这条工作间会话的用户请求生成一个 ProjectTree 短标题。',
    '要求：只输出标题本身；中文 4 到 12 个字或英文 2 到 6 个词；不要引号、标点、编号、解释、Markdown。',
    '',
    '用户请求：',
    titleInput,
  ].join('\n');

  const titleQuery = query({
    prompt,
    options: {
      cwd: command.working_dir,
      env,
      pathToClaudeCodeExecutable: command.claude_path ?? undefined,
      includePartialMessages: false,
      maxTurns: 1,
      model,
      persistSession: false,
      settingSources: [...CLAUDE_SKILL_SETTING_SOURCES],
      tools: [],
      permissionMode: 'plan',
    },
  });

  const timeoutMs = 30_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    titleQuery.close();
  }, timeoutMs);

  try {
    const chunks: string[] = [];
    for await (const message of titleQuery) {
      if (message.type === 'assistant') {
        const text = extractClaudeAssistantText(message.message);
        if (text.trim()) {
          chunks.push(text);
        }
        continue;
      }

      if (message.type === 'result' && (message as { subtype?: string }).subtype !== 'success') {
        throw new Error('Claude title query failed.');
      }
    }

    if (timedOut) {
      throw new Error(`Claude title query timed out after ${timeoutMs}ms.`);
    }

    const title = chunks.join(' ').trim();
    emit({ type: 'title_result', title: title || null });
  } finally {
    clearTimeout(timeout);
    titleQuery.close();
  }
}

function extractClaudeAssistantThinking(message: unknown): string[] {
  return extractClaudeAssistantContent(message).thinking;
}

function uniqueNonEmptyTextEntries(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];

  values.forEach((value) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    next.push(trimmed);
  });

  return next;
}

function resetClaudeTurnTracking() {
  claudeSawPartialText = false;
  claudeSawPartialThinking = false;
  claudeTurnCompletionEmitted = false;
  claudeSeenMessageIds.clear();
}

function emitClaudeTurnCompleted(detail: string) {
  if (claudeTurnCompletionEmitted) {
    return false;
  }

  claudeTurnCompletionEmitted = true;
  emitEvent({
    type: 'lifecycle',
    stage: 'turn_completed',
    detail,
  });
  if (applyPendingClaudeSettingsAfterTurn()) {
    emitStatus('ready', 'Settings applied.');
    return true;
  }
  emitStatus('ready', 'Ready for the next prompt.');
  scheduleClaudeIdleClose();
  return true;
}

function emitClaudeTurnInterrupted(detail = 'Claude turn interrupted by desktop workspace.') {
  claudeTurnAwaitingResult = false;
  claudeLastSessionState = 'idle';
  resetClaudeTurnTracking();
  claudeTurnCompletionEmitted = true;
  if (!claudeInterruptCompletionEmitted) {
    claudeInterruptCompletionEmitted = true;
    emitEvent({
      type: 'lifecycle',
      stage: 'turn_interrupted',
      detail,
    });
  }
  if (applyPendingClaudeSettingsAfterTurn()) {
    emitStatus('ready', 'Settings applied.');
    return;
  }
  emitStatus('ready', 'Turn interrupted. Ready for the next prompt.');
  scheduleClaudeIdleClose();
}

function emitClaudeIncompleteResponse() {
  if (!claudeTurnAwaitingResult) {
    return false;
  }

  claudeTurnAwaitingResult = false;
  claudeLastSessionState = 'idle';
  claudeTurnCompletionEmitted = true;
  emitEvent({
    type: 'session_completed',
    reason: CLAUDE_INCOMPLETE_RESPONSE_REASON,
  });
  emitStatus('ready', 'Claude response incomplete. Ready to retry.');
  return true;
}

function categorizeClaudeTool(name: string) {
  if (name.includes('AskUser') || name.includes('Question')) {
    return userInputToolCategory(name, 'question');
  }

  if (name.includes('PlanMode') && name.includes('Enter')) {
    return userInputToolCategory(name, 'plan_entry');
  }

  if (name.includes('PlanMode') && name.includes('Exit')) {
    return userInputToolCategory(name, 'plan_exit');
  }

  switch (name) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return toolCategory(name, 'execution');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return toolCategory(name, 'file_op');
    case 'Glob':
    case 'Grep':
    case 'LSP':
    case 'WebFetch':
    case 'WebSearch':
    case 'ToolSearch':
      return toolCategory(name, 'search');
    default:
      if (name.includes('Task') || name.includes('Todo')) {
        return toolCategory(name, 'task_mgmt');
      }
      return toolCategory(name, 'unknown');
  }
}

function summarizeQuestionInput(input: Record<string, unknown>) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const firstQuestion = questions[0];
  if (!firstQuestion || typeof firstQuestion !== 'object') {
    return null;
  }

  const questionText = typeof firstQuestion.question === 'string'
    ? firstQuestion.question
    : '';
  if (!formatPermissionPreview(questionText)) {
    return null;
  }

  return formatPermissionPreview(`需要用户回答 ${questions.length} 个问题：${questionText}`);
}

function extractStringField(
  input: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && formatPermissionPreview(value)) {
      return value;
    }
  }
  return null;
}

function summarizeClaudeToolInput(
  toolName: string,
  input: Record<string, unknown>,
  options?: {
    title?: string;
    description?: string;
    blockedPath?: string;
    decisionReason?: string;
  },
) {
  const questionSummary = summarizeQuestionInput(input);
  if (questionSummary) {
    return questionSummary;
  }

  if (toolName.includes('PlanMode') && toolName.includes('Exit')) {
    const planSummary = extractStringField(input, ['plan']);
    if (planSummary) {
      return formatPermissionPreview(planSummary);
    }
  }

  if (toolName === 'Bash') {
    const command = extractStringField(input, ['command']);
    if (command) {
      return formatPermissionPreview(command);
    }
  }

  const pathLikeValue = extractStringField(input, [
    'file_path',
    'path',
    'target_file',
    'pattern',
    'query',
  ]);
  if (pathLikeValue) {
    return formatPermissionPreview(pathLikeValue);
  }

  const displayReason = [
    options?.title,
    options?.description,
    options?.blockedPath,
    options?.decisionReason,
  ].find((value): value is string => (
    typeof value === 'string' && formatPermissionPreview(value).length > 0
  ));
  if (displayReason) {
    return formatPermissionPreview(displayReason);
  }

  return formatPermissionPreview(compactJson(input));
}

function parseClaudeInteractiveToolPrompt(name: string, input: Record<string, unknown>) {
  if (name.includes('AskUser') || name.includes('Question')) {
    const questions = Array.isArray(input.questions)
      ? input.questions
        .map((value) => {
          if (!value || typeof value !== 'object' || typeof value.question !== 'string') {
            return null;
          }

          const options = Array.isArray(value.options)
            ? value.options
              .map((option) => {
                if (!option || typeof option !== 'object' || typeof option.label !== 'string') {
                  return null;
                }

                const label = option.label.trim();
                if (!label) {
                  return null;
                }

                return {
                  label,
                  description: typeof option.description === 'string' && option.description.trim()
                    ? option.description.trim()
                    : undefined,
                  preview: typeof option.preview === 'string' && option.preview.trim()
                    ? option.preview.trim()
                    : undefined,
                };
              })
              .filter((option): option is {
                label: string;
                description?: string;
                preview?: string;
              } => Boolean(option))
            : [];

          return {
            question: value.question.trim(),
            header: typeof value.header === 'string' && value.header.trim()
              ? value.header.trim()
              : undefined,
            multiSelect: value.multiSelect === true,
            options,
          };
        })
        .filter((question): question is {
          question: string;
          header?: string;
          multiSelect: boolean;
          options: Array<{ label: string; description?: string; preview?: string }>;
        } => Boolean(question))
      : [];

    return {
      prompt_type: 'ask_user_question' as const,
      questions,
    };
  }

  if (name.includes('PlanMode') && name.includes('Enter')) {
    return {
      prompt_type: 'plan_entry' as const,
    };
  }

  if (name.includes('PlanMode') && name.includes('Exit')) {
    const allowedPrompts = Array.isArray(input.allowedPrompts)
      ? input.allowedPrompts
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
      : [];
    const planSummary = extractStringField(input, ['plan']);

    return {
      prompt_type: 'plan_exit' as const,
      allowed_prompts: allowedPrompts,
      plan_summary: planSummary || undefined,
    };
  }

  return undefined;
}

function emitClaudeToolUseStarted(payload: {
  toolUseId: string;
  rawName: string;
  inputSummary: string;
  needsResponse: boolean;
  input?: Record<string, unknown>;
  prompt?: Record<string, unknown>;
}) {
  if (!payload.toolUseId) {
    return;
  }

  if (payload.input) {
    pendingClaudeToolInputs.set(payload.toolUseId, payload.input);
  }

  if (startedToolNames.has(payload.toolUseId)) {
    return;
  }

  startedToolNames.set(payload.toolUseId, payload.rawName);
  emitEvent({
    type: 'tool_use_started',
    tool_use_id: payload.toolUseId,
    category: categorizeClaudeTool(payload.rawName),
    raw_name: payload.rawName,
    input_summary: payload.inputSummary,
    needs_response: payload.needsResponse,
    ...(payload.prompt ? { prompt: payload.prompt } : {}),
  });
}

function emitClaudeToolUseCompleted(
  toolUseId: string,
  resultSummary: string,
  success: boolean,
  todoSnapshot?: TodoSnapshotV1,
) {
  if (!toolUseId || completedToolUseIds.has(toolUseId)) {
    return;
  }

  completedToolUseIds.add(toolUseId);
  const rawName = startedToolNames.get(toolUseId) ?? 'tool';
  startedToolNames.delete(toolUseId);
  pendingClaudeToolInputs.delete(toolUseId);
  emitEvent({
    type: 'tool_use_completed',
    tool_use_id: toolUseId,
    raw_name: rawName,
    result_summary: resultSummary,
    success,
    ...(todoSnapshot ? { todo_snapshot: todoSnapshot } : {}),
  });
}

function summarizeClaudeToolResult(block: Record<string, unknown>) {
  const content = block.content;
  if (typeof content === 'string' && content.trim()) {
    return truncateSummary(content);
  }

  if (Array.isArray(content)) {
    const text = content
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry.trim();
        }
        if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
          return entry.text.trim();
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) {
      return truncateSummary(text);
    }
  }

  if (
    content
    && typeof content === 'object'
    && typeof (content as { text?: string }).text === 'string'
    && (content as { text: string }).text.trim()
  ) {
    return truncateSummary((content as { text: string }).text);
  }

  return truncateSummary(compactJson(content ?? block));
}

function buildAllowedClaudeToolResult(
  input: Record<string, unknown>,
  toolUseId: string,
) {
  return {
    behavior: 'allow' as const,
    updatedInput: input,
    toolUseID: toolUseId,
  };
}

function isClaudeAskUserQuestionTool(name: string) {
  const category = categorizeClaudeTool(name);
  return category.category === 'user_input' && category.kind === 'question';
}

function isClaudePlanExitTool(name: string) {
  const category = categorizeClaudeTool(name);
  return category.category === 'user_input' && category.kind === 'plan_exit';
}

function buildDeniedClaudeToolResult(toolUseId: string, message: string) {
  return {
    behavior: 'deny' as const,
    message,
    toolUseID: toolUseId,
  };
}

function buildAskUserQuestionUpdatedInput(
  input: Record<string, unknown>,
  answers: Record<string, string>,
  annotations?: Record<string, { preview?: string; notes?: string }>,
) {
  const updatedInput: Record<string, unknown> = {
    ...input,
    answers,
  };

  if (annotations && Object.keys(annotations).length > 0) {
    updatedInput.annotations = annotations;
  }

  return updatedInput;
}

function summarizeAskUserQuestionAnswers(
  answers: Record<string, string>,
  annotations?: Record<string, { preview?: string; notes?: string }>,
) {
  const parts = Object.entries(answers)
    .map(([question, answer]) => {
      const trimmedQuestion = question.trim();
      const trimmedAnswer = answer.trim();
      if (!trimmedAnswer) {
        return null;
      }

      const note = annotations?.[question]?.notes?.trim();
      const base = trimmedQuestion
        ? `"${trimmedQuestion}"="${trimmedAnswer}"`
        : `"${trimmedAnswer}"`;
      return note ? `${base} user notes: ${note}` : base;
    })
    .filter((value): value is string => Boolean(value));

  if (parts.length === 0) {
    return 'User answered AskUserQuestion.';
  }

  return truncateSummary(
    `User has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`,
    240,
  );
}

function summarizePlanExitApproval(answers: Record<string, string>) {
  const approval = Object.values(answers)
    .map((value) => value.trim())
    .find(Boolean);

  return approval
    ? truncateSummary(`User approved the plan: ${approval}`, 240)
    : 'User approved the plan.';
}

function planExitResponseApproves(answers: Record<string, string>) {
  return answers.decision?.trim() === 'approve';
}

function summarizePlanExitFeedback(answers: Record<string, string>) {
  const feedback = answers.feedback?.trim()
    || Object.values(answers)
      .map((value) => value.trim())
      .find(Boolean)
    || 'Please revise the plan.';

  return truncateSummary(`User requested plan changes: ${feedback}`, 240);
}

async function waitForAskUserQuestionResponse(
  input: Record<string, unknown>,
  toolUseId: string,
) {
  return await new Promise<ReturnType<typeof buildAllowedClaudeToolResult> | {
    behavior: 'deny';
    message: string;
    toolUseID: string;
  }>((resolve) => {
    pendingClaudeInteractivePrompts.set(toolUseId, {
      input,
      resolve,
    });
  });
}

async function waitForPlanExitApproval(
  input: Record<string, unknown>,
  toolUseId: string,
) {
  return await new Promise<ReturnType<typeof buildAllowedClaudeToolResult> | {
    behavior: 'deny';
    message: string;
    toolUseID: string;
  }>((resolve) => {
    pendingClaudeInteractivePrompts.set(toolUseId, {
      input,
      resolve,
    });
  });
}

async function waitForPermission(
  toolName: string,
  input: Record<string, unknown>,
  options: ClaudePermissionRequestOptions,
) {
  const toolUseId = options.toolUseID;
  const requestId = resolveClaudePermissionRequestId(options);
  const inputSummary = summarizeClaudeToolInput(toolName, input, options);

  emitClaudeToolUseStarted({
    toolUseId,
    rawName: toolName,
    inputSummary,
    needsResponse: false,
    input,
  });
  emitEvent({
    type: 'permission_required',
    request_id: requestId,
    tool_use_id: toolUseId,
    tool_name: formatPermissionPreview(options.displayName || toolName, 80),
    input_summary: inputSummary,
  });

  const approved = await new Promise<boolean>((resolve) => {
    pendingPermissions.set(requestId, { resolve });
  });

  emitEvent({
    type: 'permission_responded',
    request_id: requestId,
    tool_use_id: toolUseId,
    approved,
    responder: 'desktop',
  });

  if (!approved) {
    emitClaudeToolUseCompleted(toolUseId, 'Permission denied in desktop workspace.', false);
  }

  return approved
    ? buildAllowedClaudeToolResult(input, toolUseId)
    : buildDeniedClaudeToolResult(toolUseId, 'Permission denied in desktop workspace.');
}

function handleClaudePartialEvent(rawEvent: Record<string, unknown>) {
  if (rawEvent.type === 'message_start') {
    resetClaudeTurnTracking();
    return;
  }

  if (rawEvent.type !== 'content_block_delta') {
    return;
  }

  const delta = rawEvent.delta as Record<string, unknown> | undefined;
  if (!delta || typeof delta.type !== 'string') {
    return;
  }

  if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
    claudeSawPartialText = true;
    emitEvent({
      type: 'assistant_chunk',
      text: delta.text,
    });
    return;
  }

  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
    claudeSawPartialThinking = true;
    emitEvent({
      type: 'system_message',
      message: delta.thinking,
    });
  }
}

function handleClaudeCompactBoundary(message: Record<string, unknown>) {
  const metadata = message.compact_metadata && typeof message.compact_metadata === 'object'
    ? message.compact_metadata as Record<string, unknown>
    : {};
  const trigger = typeof metadata.trigger === 'string' ? metadata.trigger : undefined;
  const preTokens = typeof metadata.pre_tokens === 'number' ? metadata.pre_tokens : undefined;
  const postTokens = typeof metadata.post_tokens === 'number' ? metadata.post_tokens : undefined;
  const parts = ['Claude compacted the context.'];
  if (trigger === 'manual' || trigger === 'auto') {
    parts.push(`trigger=${trigger}`);
  }
  if (preTokens !== undefined) {
    parts.push(`pre_tokens=${preTokens}`);
  }
  if (postTokens !== undefined) {
    parts.push(`post_tokens=${postTokens}`);
  }

  emitEvent({
    type: 'lifecycle',
    stage: 'compact_completed',
    detail: parts.join(' '),
  });

  // Emit fresh context snapshot after compaction
  void emitClaudeContextUsage();
}

async function emitClaudeContextUsage() {
  if (!currentClaudeQuery) return;
  try {
    const ctx = await currentClaudeQuery.getContextUsage();
    claudeContextUsageFailureKey = null;
    emitEvent({
      type: 'context_usage',
      provider: 'claude',
      used_tokens: ctx.totalTokens,
      max_tokens: ctx.rawMaxTokens || ctx.maxTokens,
      raw_max_tokens: ctx.rawMaxTokens,
      percentage: ctx.rawMaxTokens
        ? (ctx.totalTokens / ctx.rawMaxTokens) * 100
        : ctx.percentage,
      auto_compact_threshold: ctx.autoCompactThreshold ?? null,
      is_auto_compact_enabled: ctx.isAutoCompactEnabled,
      model: ctx.model,
      categories: ctx.categories.map((c: { name: string; tokens: number }) => ({
        name: c.name,
        tokens: c.tokens,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = `Claude context usage unavailable: ${message}`;
    if (detail === claudeContextUsageFailureKey) {
      return;
    }
    claudeContextUsageFailureKey = detail;
    emitEvent({
      type: 'lifecycle',
      stage: 'context_usage_unavailable',
      detail,
    });
  }
}

function emitCodexContextUsageSnapshot(snapshot: {
  usedTokens: number;
  maxTokens: number;
  percentage: number;
  model: string;
  categories: Array<{ name: string; tokens: number }>;
}) {
  const key = [
    snapshot.usedTokens,
    snapshot.maxTokens,
    Math.round(snapshot.percentage * 10) / 10,
    snapshot.model,
  ].join(':');
  if (key === codexLastContextUsageKey) {
    return false;
  }
  codexLastContextUsageKey = key;

  emitEvent({
    type: 'context_usage',
    provider: 'codex',
    used_tokens: snapshot.usedTokens,
    max_tokens: snapshot.maxTokens,
    raw_max_tokens: snapshot.maxTokens,
    percentage: snapshot.percentage,
    auto_compact_threshold: null,
    is_auto_compact_enabled: true,
    model: snapshot.model,
    categories: snapshot.categories,
  });
  return true;
}

function emitCodexContextUsageFromTokenCount(payload: Record<string, unknown>) {
  const snapshot = buildCodexContextUsageFromTokenCount(payload);
  if (!snapshot) return false;
  return emitCodexContextUsageSnapshot(snapshot);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emitCodexContextUsageFromSessionFile(
  providerSessionId: string | null,
  retries = 0,
  delayMs = 80,
) {
  const sessionId = providerSessionId?.trim();
  if (!sessionId) return false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const filePath = findCodexSessionFile(sessionId);
    if (filePath) {
      const snapshot = readLatestCodexContextUsageFromSessionFile(filePath);
      if (snapshot && emitCodexContextUsageSnapshot(snapshot)) {
        return true;
      }
    }

    if (attempt < retries) {
      await sleep(delayMs);
    }
  }

  return false;
}

function handleClaudeStatusMessage(message: Record<string, unknown>) {
  const compactResult = message.compact_result;
  if (compactResult === 'success') {
    emitEvent({
      type: 'lifecycle',
      stage: 'compact_completed',
      detail: 'Claude compacted the context.',
    });
    return true;
  }

  if (compactResult === 'failed') {
    const compactError = typeof message.compact_error === 'string' && message.compact_error.trim()
      ? message.compact_error.trim()
      : 'Claude failed to compact the context.';
    emitEvent({
      type: 'lifecycle',
      stage: 'compact_failed',
      detail: compactError,
    });
    return true;
  }

  if (message.status === 'compacting') {
    emitEvent({
      type: 'lifecycle',
      stage: 'compacting',
      detail: 'Claude is compacting the context.',
    });
    return true;
  }

  return false;
}

function applySettingsToInitCommand(settings: RuntimeSettingsPatch) {
  if (!initCommand) return false;
  if (settings.permMode !== undefined) {
    initCommand.perm_mode = settings.permMode;
  }
  if (settings.envVars !== undefined) initCommand.env_vars = settings.envVars;
  if (settings.envName !== undefined) initCommand.env_name = settings.envName;
  if (settings.effort !== undefined) initCommand.effort = settings.effort || undefined;
  return true;
}

function applyPendingSettingsToInitCommand() {
  if (!pendingSettings) return false;
  const settings = pendingSettings;
  pendingSettings = null;
  return applySettingsToInitCommand(settings);
}

function applySettingsCommand(command: UpdateSettingsCommand) {
  return applySettingsToInitCommand({
    envName: command.env_name,
    permMode: command.perm_mode,
    envVars: command.env_vars,
    effort: command.effort,
  });
}

function queuePendingSettings(command: UpdateSettingsCommand) {
  pendingSettings = {
    ...pendingSettings,
    ...(command.env_name !== undefined ? { envName: command.env_name } : {}),
    ...(command.perm_mode !== undefined ? { permMode: command.perm_mode } : {}),
    ...(command.env_vars !== undefined ? { envVars: command.env_vars } : {}),
    ...(command.effort !== undefined ? { effort: command.effort } : {}),
  };
}

function isClaudePermissionOnlySettingsCommand(command: UpdateSettingsCommand) {
  return command.perm_mode !== undefined
    && command.env_name === undefined
    && command.env_vars === undefined
    && command.effort === undefined;
}

async function applyClaudePermissionSettingsCommand(command: UpdateSettingsCommand) {
  if (!initCommand || initCommand.provider !== 'claude' || !isClaudePermissionOnlySettingsCommand(command)) {
    return false;
  }

  await applyClaudePermissionModeToQuery(currentClaudeQuery, command.perm_mode!);
  applySettingsCommand(command);
  return true;
}

function hasRetainedClaudeRuntime() {
  return Boolean(claudeConsumeLoop || claudeInputQueue || currentClaudeQuery);
}

function canApplySettingsImmediately() {
  if (!initCommand) return false;
  if (initCommand.provider === 'codex') {
    return !activeTurn;
  }
  return !hasRetainedClaudeRuntime();
}

function applyPendingClaudeSettingsAfterTurn() {
  if (initCommand?.provider !== 'claude' || !pendingSettings) {
    return false;
  }

  applyPendingSettingsToInitCommand();
  closeClaudeQueryForRecovery();
  return true;
}

function applyClaudeSettingsByRestartingIdleRuntime(command: UpdateSettingsCommand) {
  if (shouldInterruptCurrentClaudeTurn()) {
    return false;
  }

  applySettingsCommand(command);
  closeClaudeQueryForRecovery();
  return true;
}

function buildClaudeQueryOptions() {
  if (!initCommand || initCommand.provider !== 'claude') {
    throw new Error('Native runtime helper not initialized for Claude');
  }

  const permission = normalizeClaudePermissionMode(initCommand.perm_mode, {
    allowDangerouslySkipPermissions: initCommand.allow_dangerously_skip_permissions === true,
  });
  const env = buildClaudeQueryEnv({
    envVars: initCommand.env_vars,
    effort: initCommand.effort,
  });
  const model = resolveClaudeRuntimeModel(initCommand.env_vars);

  return {
    cwd: initCommand.working_dir,
    env,
    resume: currentProviderSessionId ?? undefined,
    pathToClaudeCodeExecutable: initCommand.claude_path ?? undefined,
    includePartialMessages: true,
    includeHookEvents: true,
    persistSession: true,
    enableFileCheckpointing: true,
    extraArgs: { 'replay-user-messages': null },
    settingSources: [...CLAUDE_SKILL_SETTING_SOURCES],
    allowedTools: ensureBrowserMcpToolsAllowed(
      ensureClaudeSkillToolAllowed(initCommand.allowed_tools),
      initCommand.perm_mode,
    ),
    disallowedTools: initCommand.disallowed_tools ?? undefined,
    mcpServers: {
      'ccem-browser': createCcemBrowserMcpServer(
        () => initCommand?.perm_mode ?? 'safe',
        browserToolBridge.sendBrowserToolRequest,
      ),
    },
    ...(model ? { model } : {}),
    hooks: buildClaudePlanModeHooks(
      () => initCommand?.provider === 'claude' && initCommand.perm_mode === 'plan',
    ),
    canUseTool: async (toolName: string, input: unknown, options: ClaudeToolPermissionOptions) => {
      if (isClaudeAskUserQuestionTool(toolName)) {
        return waitForAskUserQuestionResponse(input, options.toolUseID);
      }
      if (isClaudePlanExitTool(toolName)) {
        return waitForPlanExitApproval(input, options.toolUseID);
      }
      if (isClaudeInteractiveUserInputTool(toolName)) {
        return buildAllowedClaudeToolResult(input, options.toolUseID);
      }
      if (isBrowserEvaluateToolName(toolName)) {
        if (permission.allowDangerouslySkipPermissions || browserEvaluateApprovedForSession) {
          return buildAllowedClaudeToolResult(input, options.toolUseID);
        }
        const result = await waitForPermission(toolName, input, {
          ...options,
          title: options.title ?? 'Claude wants to evaluate JavaScript in the embedded browser.',
          displayName: options.displayName ?? 'Browser evaluate',
          description: options.description ?? 'This runs arbitrary JavaScript in the current embedded browser page for this session.',
        });
        if (result.behavior === 'allow') {
          browserEvaluateApprovedForSession = true;
        }
        return result;
      }
      return waitForPermission(toolName, input, options);
    },
    ...permission,
  };
}

function denyPendingPermissions() {
  for (const pending of pendingPermissions.values()) {
    pending.resolve(false);
  }
  pendingPermissions.clear();
}

function denyPendingClaudeInteractivePrompts(message: string) {
  for (const [toolUseId, pending] of pendingClaudeInteractivePrompts.entries()) {
    pending.resolve({
      behavior: 'deny',
      message,
      toolUseID: toolUseId,
    });
  }
  pendingClaudeInteractivePrompts.clear();
}

function teardownClaudeSession() {
  browserToolBridge.rejectAll('Claude runtime session was closed before the browser tool completed.');
  browserEvaluateApprovedForSession = false;
  closeClaudeQueryForRecovery();
  clearAllClaudeQueryState();
  claudeConsumeLoop = null;
  resetClaudeTurnTracking();
}

function teardownCodexSession(envChanged: boolean) {
  codexThread = null;
  codexLastContextUsageKey = null;
  if (envChanged) codexClient = null;
}

async function consumeClaudeMessages() {
  if (!initCommand) {
    throw new Error('Native runtime helper not initialized');
  }

  claudeContextUsageFailureKey = null;

  const inputQueue = new AsyncMessageQueue<SDKUserMessage>();
  const claudeQuery = query({
    prompt: inputQueue,
    options: buildClaudeQueryOptions(),
  });
  const querySnapshot = claudeQuerySlot.activate(claudeQuery, inputQueue);
  currentClaudeQuery = querySnapshot.query;
  claudeInputQueue = querySnapshot.inputQueue;
  let incompleteResponse = false;

  try {
    for await (const message of claudeQuery) {
      const sessionId = (message as { session_id?: string } | undefined)?.session_id;
      if (sessionId) {
        emitSessionMeta(sessionId);
      }

      if (message.type === 'stream_event') {
        if (isCurrentClaudeQuerySnapshot(querySnapshot)) {
          pendingClaudePromptReplay = null;
        }
        const event = (message as { event?: Record<string, unknown> }).event;
        if (event) {
          handleClaudePartialEvent(event);
        }
        continue;
      }

      if (message.type === 'assistant') {
        if (isCurrentClaudeQuerySnapshot(querySnapshot)) {
          pendingClaudePromptReplay = null;
        }
        // Emit token_usage per unique message (parallel tool calls share the same id)
        const msgId = (message as { message?: { id?: string; usage?: Record<string, unknown> } }).message?.id;
        const msgUsage = (message as { message?: { id?: string; usage?: Record<string, unknown> } }).message?.usage;
        if (msgId && !claudeSeenMessageIds.has(msgId) && msgUsage) {
          claudeSeenMessageIds.add(msgId);
          const outputTokens = typeof msgUsage.output_tokens === 'number' ? msgUsage.output_tokens : 0;
          emitEvent({
            type: 'token_usage',
            provider: 'claude',
            input_tokens: typeof msgUsage.input_tokens === 'number' ? msgUsage.input_tokens : 0,
            output_tokens: outputTokens,
            cache_read_tokens: typeof msgUsage.cache_read_input_tokens === 'number' ? msgUsage.cache_read_input_tokens : 0,
            cache_creation_tokens: typeof msgUsage.cache_creation_input_tokens === 'number' ? msgUsage.cache_creation_input_tokens : 0,
          });
        }

        const contentBlocks = getClaudeContentBlocks(message.message);
        const emittedThinking = new Set<string>();
        contentBlocks.forEach((block) => {
          if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            const thinking = block.thinking.trim();
            if (!thinking || claudeSawPartialThinking || emittedThinking.has(thinking)) {
              return;
            }
            emittedThinking.add(thinking);
            emitEvent({
              type: 'system_message',
              message: thinking,
            });
            return;
          }

          if (block.type === 'text' && typeof block.text === 'string' && block.text && !claudeSawPartialText) {
            emitEvent({
              type: 'assistant_chunk',
              text: block.text,
            });
            return;
          }

          if (
            block.type === 'tool_use'
            && typeof block.id === 'string'
            && typeof block.name === 'string'
            && block.name
          ) {
            const input = block.input && typeof block.input === 'object'
              ? block.input as Record<string, unknown>
              : {};
            const prompt = parseClaudeInteractiveToolPrompt(block.name, input);
            const category = categorizeClaudeTool(block.name);
            const needsResponse = category.category === 'user_input'
              && (category.kind === 'question' || category.kind === 'plan_exit');
            emitClaudeToolUseStarted({
              toolUseId: block.id,
              rawName: block.name,
              inputSummary: summarizeClaudeToolInput(block.name, input),
              needsResponse,
              input,
              prompt,
            });
          }
        });
        continue;
      }

      if (message.type === 'user') {
        const checkpoint = buildClaudeFileCheckpointEvent(message, currentProviderSessionId);
        if (checkpoint) {
          emitEvent(checkpoint);
        }

        const contentBlocks = getClaudeContentBlocks(message.message);
        contentBlocks.forEach((block) => {
          if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
            return;
          }
          const success = block.is_error !== true;
          const rawName = startedToolNames.get(block.tool_use_id) ?? 'tool';
          const input = pendingClaudeToolInputs.get(block.tool_use_id);
          const todoSnapshot = success && input
            ? todoSnapshotTracker.fromClaudeToolCompleted(
              rawName,
              input,
              message.tool_use_result ?? block.content,
            )
            : undefined;
          emitClaudeToolUseCompleted(
            block.tool_use_id,
            summarizeClaudeToolResult(block),
            success,
            todoSnapshot,
          );
        });
        continue;
      }

      if (message.type === 'tool_progress') {
        emitClaudeToolUseStarted({
          toolUseId: message.tool_use_id,
          rawName: message.tool_name,
          inputSummary: `Running ${message.tool_name}`,
          needsResponse: false,
        });
        continue;
      }

      if (message.type === 'tool_use_summary') {
        for (const toolUseId of message.preceding_tool_use_ids) {
          emitClaudeToolUseCompleted(toolUseId, message.summary, true);
        }
        continue;
      }

      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        handleClaudeCompactBoundary(message as Record<string, unknown>);
        continue;
      }

      if (message.type === 'system' && message.subtype === 'status') {
        if (handleClaudeStatusMessage(message as Record<string, unknown>)) {
          continue;
        }
        const statusLabel = message.status || 'idle';
        emitEvent({
          type: 'lifecycle',
          stage: 'status',
          detail: `Claude status: ${statusLabel}`,
        });
        continue;
      }

      if (message.type === 'system' && message.subtype === 'session_state_changed') {
        if (message.state === 'running') {
          pendingClaudePromptReplay = null;
        }
        if (message.state !== claudeLastSessionState) {
          if (message.state === 'running') {
            resetClaudeTurnTracking();
            emitEvent({
              type: 'lifecycle',
              stage: 'turn_started',
              detail: 'Claude is processing a turn.',
            });
            emitStatus('processing', 'Claude is processing a turn.');
          }

          if (message.state === 'idle') {
            if (claudeInterruptRequested) {
              emitClaudeTurnInterrupted();
            }
          }
        }

        claudeLastSessionState = message.state;

        continue;
      }

      if (message.type === 'result') {
        if (isCurrentClaudeQuerySnapshot(querySnapshot)) {
          claudeTurnAwaitingResult = false;
          pendingClaudePromptReplay = null;
        }
        if (claudeInterruptRequested) {
          emitClaudeTurnInterrupted();
          claudeInterruptRequested = false;
          continue;
        }

        // Emit turn-total token_usage with cost estimate
        const resultUsage = (message as { usage?: Record<string, unknown> }).usage;
        const totalCostUsd = (message as { total_cost_usd?: number }).total_cost_usd;
        if (resultUsage) {
          const outputTokens = typeof resultUsage.output_tokens === 'number' ? resultUsage.output_tokens : 0;
          emitEvent({
            type: 'token_usage',
            provider: 'claude',
            input_tokens: typeof resultUsage.input_tokens === 'number' ? resultUsage.input_tokens : 0,
            output_tokens: outputTokens,
            cache_read_tokens: typeof resultUsage.cache_read_input_tokens === 'number' ? resultUsage.cache_read_input_tokens : 0,
            cache_creation_tokens: typeof resultUsage.cache_creation_input_tokens === 'number' ? resultUsage.cache_creation_input_tokens : 0,
            total_cost_usd: typeof totalCostUsd === 'number' ? totalCostUsd : null,
            scope: 'turn_total',
          });
        }

        if (message.subtype === 'success') {
          emitClaudeTurnCompleted(message.result || 'Claude turn completed.');
          // Defer context usage fetch to next tick — SDK internal state may not
          // be fully updated until after the result message is consumed.
          await new Promise(resolve => setImmediate(resolve));
          await emitClaudeContextUsage();
        } else {
          const reason = message.errors?.join('\n') || message.subtype;
          emitClaudeTurnCompleted(reason || 'Claude turn completed.');
          emitEvent({
            type: 'session_completed',
            reason,
          });
        }
        continue;
      }

      if (message.type === 'auth_status' && message.error) {
        emitEvent({
          type: 'stderr_line',
          line: message.error,
        });
      }
    }
    incompleteResponse = claudeTurnAwaitingResult
      && pendingClaudePromptReplay === null
      && !stopped
      && !claudeInterruptRequested
      && isCurrentClaudeQuerySnapshot(querySnapshot);
  } finally {
    if (claudeInputQueue === inputQueue) {
      claudeInputQueue = null;
    }
    if (claudeQuerySlot.isCurrent(querySnapshot)) {
      clearClaudeIdleCloseTimer();
      clearCurrentClaudeQuerySnapshot(querySnapshot);
    }
    if (initCommand?.provider === 'claude' && pendingSettings && !claudeInputQueue && !currentClaudeQuery) {
      applyPendingSettingsToInitCommand();
      emitStatus('ready', 'Settings applied.');
    }
  }

  if (incompleteResponse) {
    emitClaudeIncompleteResponse();
  }
}

async function ensureClaudeSession() {
  if (!initCommand) {
    throw new Error('Native runtime helper not initialized');
  }

  if (initCommand.provider !== 'claude') {
    return;
  }

  if (!claudeConsumeLoop || !claudeInputQueue) {
    if (!claudeInputQueue && !currentClaudeQuery) {
      applyPendingSettingsToInitCommand();
    }
    let loop: Promise<void>;
    loop = consumeClaudeMessages().catch((error) => {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (claudeInterruptRequested) {
        emitClaudeTurnInterrupted();
        claudeInterruptRequested = false;
        return;
      }
      if (stopped || isAbort) {
        return;
      }

      if (!currentClaudeQuery) {
        claudeTurnAwaitingResult = false;
      }

      const message = error instanceof Error ? error.message : String(error);
      emitEvent({
        type: 'stderr_line',
        line: message,
      });
      emitEvent({
        type: 'session_completed',
        reason: message,
      });
      emitStatus('error', message);
    }).finally(() => {
      if (claudeConsumeLoop === loop) {
        claudeConsumeLoop = null;
      }
      void replayPendingClaudePromptIfNeeded().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        emitEvent({
          type: 'stderr_line',
          line: message,
        });
        emitEvent({
          type: 'session_completed',
          reason: message,
        });
        emitStatus('error', message);
      });
    });
    claudeConsumeLoop = loop;
  }
}

async function replayPendingClaudePromptIfNeeded() {
  if (!pendingClaudePromptReplay || stopped || initCommand?.provider !== 'claude') {
    return;
  }

  const prompt = pendingClaudePromptReplay;
  pendingClaudePromptReplay = null;
  await ensureClaudePromptQueueReady();
  enqueueClaudePrompt(prompt.text, prompt.images);
}

async function ensureClaudePromptQueueReady() {
  clearClaudeIdleCloseTimer();
  await ensureClaudeSession();

  if (!claudeInputQueue) {
    await ensureClaudeSession();
  }
}

function enqueueClaudePrompt(text: string, images?: PromptImage[] | null) {
  if (!claudeInputQueue) {
    throw new Error('Claude streaming input queue is not ready');
  }

  pendingClaudePromptReplay = { text, images };
  claudeInterruptRequested = false;
  claudeInterruptCompletionEmitted = false;
  const parts = buildPromptContentParts(text, images);
  const hasImages = parts.some((part) => part.type === 'image');
  const content = hasImages
    ? parts.map((part) => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text };
        }
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: part.image.mediaType,
            data: part.image.base64Data,
          },
        };
      })
    : text.trim();

  resetClaudeTurnTracking();
  claudeInputQueue.push({
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
  });
  claudeTurnAwaitingResult = true;
  emitStatus('processing', 'Claude is processing a turn.');
}

async function rewindClaudeFiles(checkpointId: string) {
  const checkpoint = checkpointId.trim();
  if (!checkpoint) {
    throw new Error('Missing checkpoint id.');
  }
  if (!initCommand || initCommand.provider !== 'claude') {
    throw new Error('File rewind is only available for Claude sessions.');
  }
  if (pendingPermissions.size > 0 || pendingClaudeInteractivePrompts.size > 0) {
    throw new Error('Cannot rewind while a permission or user prompt is waiting.');
  }
  if (currentClaudeQuery && claudeLastSessionState !== 'idle' && !claudeTurnCompletionEmitted) {
    throw new Error('Cannot rewind while Claude is processing or starting a turn.');
  }

  if (currentClaudeQuery) {
    return currentClaudeQuery.rewindFiles(checkpoint);
  }

  if (!currentProviderSessionId) {
    throw new Error('Cannot rewind before Claude provides a session id.');
  }

  const rewindQuery = query({
    prompt: '',
    options: buildClaudeQueryOptions(),
  });

  try {
    for await (const message of rewindQuery) {
      const sessionId = (message as { session_id?: string } | undefined)?.session_id;
      if (sessionId) {
        emitSessionMeta(sessionId);
      }
      return await rewindQuery.rewindFiles(checkpoint);
    }
  } finally {
    rewindQuery.close();
  }

  throw new Error('Claude resume ended before file rewind could run.');
}

async function handleRewindFilesCommand(command: RewindFilesCommand) {
  const checkpointId = command.checkpoint_id.trim();
  try {
    emitStatus('processing', 'Restoring files from Claude checkpoint.');
    const result = await rewindClaudeFiles(checkpointId);
    if (!result.canRewind) {
      throw new Error(result.error || 'Claude could not rewind files for this checkpoint.');
    }
    emitEvent({
      type: 'files_rewound',
      provider: 'claude',
      checkpoint_id: checkpointId,
      files_changed: result.filesChanged ?? [],
      insertions: result.insertions ?? null,
      deletions: result.deletions ?? null,
    });
    emitStatus('ready', 'Files restored from Claude checkpoint.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitEvent({
      type: 'file_rewind_failed',
      provider: 'claude',
      checkpoint_id: checkpointId,
      error: message,
    });
    emitStatus('ready', 'File rewind failed.');
  }
}

function codexCategoryForItem(item: Record<string, unknown>) {
  switch (item.type) {
    case 'command_execution':
      return toolCategory(String(item.command || 'command'), 'execution');
    case 'file_change':
      return toolCategory('file_change', 'file_op');
    case 'web_search':
      return toolCategory('web_search', 'search');
    case 'todo_list':
      return toolCategory('todo_list', 'task_mgmt');
    default:
      return toolCategory(String(item.type || 'item'), 'unknown');
  }
}

function summarizeCodexItem(item: Record<string, unknown>) {
  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    return compactJson({
      type: 'file_change',
      changes: item.changes,
    });
  }
  if (item.type === 'todo_list' && Array.isArray(item.items)) {
    return compactJson({
      type: 'todo_list',
      items: item.items,
    });
  }
  if (typeof item.text === 'string') {
    return item.text;
  }
  if (typeof item.command === 'string') {
    return item.command;
  }
  if (Array.isArray(item.changes)) {
    return `${item.changes.length} file changes`;
  }
  if (typeof item.query === 'string') {
    return item.query;
  }
  return summarizeUnknown(item);
}

async function ensureCodexThread() {
  if (!initCommand) {
    throw new Error('Native runtime helper not initialized');
  }

  if (!codexClient) {
    codexClient = new Codex({
      codexPathOverride: initCommand.codex_path ?? undefined,
      baseUrl: initCommand.codex_base_url ?? undefined,
      apiKey: initCommand.codex_api_key ?? undefined,
      env: {
        ...process.env,
        ...initCommand.env_vars,
      },
    });
  }

  if (!codexThread) {
    const sandbox = normalizeCodexSandboxMode(initCommand.perm_mode);
    const threadOptions = {
      workingDirectory: initCommand.working_dir,
      networkAccessEnabled: sandbox.networkAccessEnabled,
      skipGitRepoCheck: true,
      sandboxMode: sandbox.sandboxMode,
      approvalPolicy: sandbox.approvalPolicy,
      ...(initCommand.effort ? { modelReasoningEffort: initCommand.effort } : {}),
    };
    codexThread = currentProviderSessionId
      ? codexClient.resumeThread(currentProviderSessionId, threadOptions)
      : codexClient.startThread(threadOptions);

    if (currentProviderSessionId) {
      emitSessionMeta(currentProviderSessionId);
      await emitCodexContextUsageFromSessionFile(currentProviderSessionId);
    }
  }

  return codexThread;
}

async function runCodexTurn(text: string, images?: PromptImage[] | null) {
  const thread = await ensureCodexThread();
  currentAbortController = new AbortController();

  let input: import('@openai/codex-sdk').Input;
  const parts = buildPromptContentParts(text, images);
  const hasImages = parts.some((part) => part.type === 'image');

  let tempFiles: string[] = [];

  if (hasImages) {
    try {
      const result = createLocalImageInputs(parts);
      input = result.inputs;
      tempFiles = result.tempFiles;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitEvent({ type: 'stderr_line', line: message });
      throw error;
    }
  } else {
    input = text.trim();
  }

  try {
    const streamed = await thread.runStreamed(input, {
      signal: currentAbortController.signal,
    });

    const seenTextByItem = new Map<string, string>();
    const seenReasoningByItem = new Map<string, string>();

    for await (const event of streamed.events) {
    const rawEvent = event as { type: string; payload?: Record<string, unknown> };
    if (rawEvent.type === 'event_msg') {
      const payload = rawEvent.payload;
      if (payload?.type === 'token_count') {
        emitCodexContextUsageFromTokenCount(payload);
      }
      continue;
    }

    if (event.type === 'thread.started') {
      emitSessionMeta(event.thread_id);
      await emitCodexContextUsageFromSessionFile(event.thread_id);
      continue;
    }

    if (event.type === 'turn.started') {
      emitEvent({
        type: 'lifecycle',
        stage: 'turn_started',
        detail: 'Codex is thinking…',
      });
      continue;
    }

    if (event.type === 'turn.completed') {
      const outputTokens = event.usage.output_tokens ?? 0;
      emitEvent({
        type: 'lifecycle',
        stage: 'turn_completed',
        detail: `Turn completed · output ${outputTokens} tokens`,
      });
      emitEvent({
        type: 'token_usage',
        provider: 'codex',
        input_tokens: event.usage.input_tokens ?? 0,
        output_tokens: outputTokens,
        cache_read_tokens: event.usage.cached_input_tokens ?? 0,
        cache_creation_tokens: 0,
      });
      await emitCodexContextUsageFromSessionFile(currentProviderSessionId, 10);
      continue;
    }

    if (event.type === 'turn.failed') {
      emitEvent({
        type: 'session_completed',
        reason: event.error.message,
      });
      continue;
    }

    if (event.type === 'error') {
      emitEvent({
        type: 'stderr_line',
        line: event.message,
      });
      continue;
    }

    const item = event.item as Record<string, unknown>;

    if (item.type === 'agent_message') {
      const nextText = typeof item.text === 'string' ? item.text : '';
      const previousText = seenTextByItem.get(String(item.id)) || '';
      if (nextText.startsWith(previousText)) {
        const delta = nextText.slice(previousText.length);
        if (delta) {
          emitEvent({
            type: 'assistant_chunk',
            text: delta,
          });
        }
      } else if (nextText) {
        emitEvent({
          type: 'assistant_chunk',
          text: nextText,
        });
      }
      seenTextByItem.set(String(item.id), nextText);
      continue;
    }

    if (item.type === 'reasoning') {
      const itemId = String(item.id || 'reasoning');
      const nextText = typeof item.text === 'string' ? item.text : '';
      const previousText = seenReasoningByItem.get(itemId) || '';

      if (nextText.startsWith(previousText)) {
        const delta = nextText.slice(previousText.length);
        if (delta) {
          emitEvent({
            type: 'system_message',
            message: delta,
          });
        }
      } else if (nextText) {
        emitEvent({
          type: 'system_message',
          message: nextText,
        });
      }

      seenReasoningByItem.set(itemId, nextText);
      continue;
    }

    if (event.type === 'item.started') {
      const todoSnapshot = item.type === 'todo_list'
        ? todoSnapshotTracker.fromCodexTodoList(item)
        : undefined;
      emitEvent({
        type: 'tool_use_started',
        tool_use_id: String(item.id || `${item.type}-${Date.now()}`),
        category: codexCategoryForItem(item),
        raw_name: String(item.type || 'item'),
        input_summary: summarizeCodexItem(item),
        needs_response: false,
        ...(todoSnapshot ? { todo_snapshot: todoSnapshot } : {}),
      });
      continue;
    }

    if (event.type === 'item.updated' && item.type === 'todo_list') {
      const todoSnapshot = todoSnapshotTracker.fromCodexTodoList(item);
      emitEvent({
        type: 'tool_use_started',
        tool_use_id: String(item.id || `${item.type}-${Date.now()}`),
        category: codexCategoryForItem(item),
        raw_name: String(item.type || 'item'),
        input_summary: summarizeCodexItem(item),
        needs_response: false,
        ...(todoSnapshot ? { todo_snapshot: todoSnapshot } : {}),
      });
      continue;
    }

    if (event.type === 'item.completed') {
      const todoSnapshot = item.type === 'todo_list'
        ? todoSnapshotTracker.fromCodexTodoList(item)
        : undefined;
      emitEvent({
        type: 'tool_use_completed',
        tool_use_id: String(item.id || `${item.type}-${Date.now()}`),
        raw_name: String(item.type || 'item'),
        result_summary: summarizeCodexItem(item),
        success: item.status !== 'failed',
        ...(todoSnapshot ? { todo_snapshot: todoSnapshot } : {}),
      });
      continue;
    }
    }
  } finally {
    cleanupTempFiles(tempFiles);
  }
}

async function runQueuedTurns() {
  if (activeTurn || !initCommand || stopped || initCommand.provider === 'claude') {
    return;
  }

  const nextPrompt = promptQueue.shift();
  if (!nextPrompt) {
    return;
  }

  activeTurn = true;
  emitStatus('processing', 'Codex is processing a turn.');
  try {
    await runCodexTurn(nextPrompt.text, nextPrompt.images);
    if (!stopped) {
      emitStatus('ready', 'Ready for the next prompt.');
    }
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (!isAbort) {
      const message = error instanceof Error ? error.message : String(error);
      emitEvent({
        type: 'stderr_line',
        line: message,
      });
      emitEvent({
        type: 'session_completed',
        reason: message,
      });
      emitStatus('error', message);
    }
  } finally {
    activeTurn = false;
    currentAbortController = null;
    if (pendingSettings) {
      const hadEnvVars = pendingSettings.envVars !== undefined;
      applyPendingSettingsToInitCommand();
      teardownCodexSession(hadEnvVars);
      emitStatus('ready', 'Settings applied.');
    }
    if (!stopped) {
      void runQueuedTurns();
    }
  }
}

async function handleCommand(command: InputCommand) {
  if (command.type === 'title_query') {
    await runWorkspaceTitleQuery(command);
    return;
  }

  if (command.type === 'init') {
    initCommand = command;
    const resumedClaudeWithoutTodoSeed = command.provider === 'claude'
      && Boolean(command.provider_session_id?.trim())
      && !command.todo_snapshot_seed;
    todoSnapshotTracker.reset(
      command.todo_snapshot_seed,
      !resumedClaudeWithoutTodoSeed,
    );
    currentProviderSessionId = command.provider_session_id ?? null;
    browserEvaluateApprovedForSession = false;
    if (currentProviderSessionId) {
      emitSessionMeta(currentProviderSessionId);
      if (command.provider === 'codex') {
        await emitCodexContextUsageFromSessionFile(currentProviderSessionId);
      }
    }
    emitStatus('ready', 'Native runtime helper initialized.');
    const initialText = command.initial_prompt?.trim() ?? '';
    const initialImages = command.initial_images?.length ? command.initial_images : null;
    if (initialText || initialImages) {
      if (command.provider === 'claude') {
        await ensureClaudePromptQueueReady();
        enqueueClaudePrompt(initialText, initialImages);
      } else {
        promptQueue.push({ text: initialText, images: initialImages });
        await runQueuedTurns();
      }
    } else if (command.provider === 'claude') {
      await ensureClaudeSession();
    }
    return;
  }

  if (command.type === 'permission_response') {
    const pending = pendingPermissions.get(command.request_id);
    if (pending) {
      pendingPermissions.delete(command.request_id);
      pending.resolve(command.approved);
    }
    return;
  }

  if (command.type === 'browser_tool_response') {
    browserToolBridge.handleBrowserToolResponse(command);
    return;
  }

  if (command.type === 'interactive_prompt_response') {
    const pending = pendingClaudeInteractivePrompts.get(command.tool_use_id);
    if (!pending) {
      return;
    }

    pendingClaudeInteractivePrompts.delete(command.tool_use_id);

    if (command.prompt_type !== 'ask_user_question' && command.prompt_type !== 'plan_exit') {
      pending.resolve({
        behavior: 'deny',
        message: 'Unsupported interactive prompt response.',
        toolUseID: command.tool_use_id,
      });
      return;
    }

    if (Object.keys(command.answers).length === 0) {
      pending.resolve({
        behavior: 'deny',
        message: 'User did not answer the question prompt.',
        toolUseID: command.tool_use_id,
      });
      return;
    }

    if (command.prompt_type === 'plan_exit') {
      if (!planExitResponseApproves(command.answers)) {
        const feedback = summarizePlanExitFeedback(command.answers);
        emitClaudeToolUseCompleted(command.tool_use_id, feedback, false);
        pending.resolve(buildDeniedClaudeToolResult(command.tool_use_id, feedback));
        return;
      }

      emitClaudeToolUseCompleted(
        command.tool_use_id,
        summarizePlanExitApproval(command.answers),
        true,
      );
      pending.resolve(buildAllowedClaudeToolResult(pending.input, command.tool_use_id));
      return;
    }

    emitClaudeToolUseCompleted(
      command.tool_use_id,
      summarizeAskUserQuestionAnswers(command.answers, command.annotations),
      true,
    );

    pending.resolve(
      buildAllowedClaudeToolResult(
        buildAskUserQuestionUpdatedInput(
          pending.input,
          command.answers,
          command.annotations,
        ),
        command.tool_use_id,
      ),
    );
    return;
  }

  if (command.type === 'rewind_files') {
    await handleRewindFilesCommand(command);
    return;
  }

  if (command.type === 'update_settings') {
    if (!initCommand) return;

    if (command.perm_mode !== undefined) {
      browserEvaluateApprovedForSession = false;
    }

    if (await applyClaudePermissionSettingsCommand(command)) {
      emitStatus('ready', 'Settings applied.');
      return;
    }

    if (initCommand.provider === 'claude') {
      if (canApplySettingsImmediately()) {
        applySettingsCommand(command);
        emitStatus('ready', 'Settings applied.');
      } else if (applyClaudeSettingsByRestartingIdleRuntime(command)) {
        emitStatus('ready', 'Settings applied.');
      } else {
        queuePendingSettings(command);
        const status = claudeLastSessionState === 'running'
          && !claudeTurnCompletionEmitted
          && !claudeInterruptCompletionEmitted
          ? 'processing'
          : 'ready';
        emitStatus(status, 'Settings will apply to the next Claude runtime.');
      }
      return;
    }

    if (canApplySettingsImmediately()) {
      applySettingsCommand(command);
      if (initCommand.provider === 'codex') {
        teardownCodexSession(command.env_vars !== undefined || command.effort !== undefined);
      }
      emitStatus('ready', 'Settings applied.');
    } else {
      queuePendingSettings(command);
      emitStatus('processing', 'Settings will apply after the current turn.');
    }
    return;
  }

  if (command.type === 'prompt') {
    const hasImages = command.images && command.images.length > 0;
    if (!command.text.trim() && !hasImages) {
      return;
    }
    if (initCommand?.provider === 'claude') {
      await ensureClaudePromptQueueReady();
      enqueueClaudePrompt(command.text.trim(), command.images);
    } else {
      promptQueue.push({ text: command.text.trim(), images: command.images });
      await runQueuedTurns();
    }
    return;
  }

  if (command.type === 'stop') {
    stopped = true;
    clearClaudeIdleCloseTimer();
    pendingClaudePromptReplay = null;
    denyPendingPermissions();
    denyPendingClaudeInteractivePrompts('Native runtime turn was interrupted before user responded.');
    browserToolBridge.rejectAll('Native runtime turn was interrupted before the browser tool completed.');

    if (initCommand?.provider === 'claude') {
      const stopTarget = captureCurrentClaudeQuerySnapshot();
      if (!shouldInterruptCurrentClaudeTurn(stopTarget)) {
        emitEvent({
          type: 'lifecycle',
          stage: 'idle_stop',
          detail: 'Desktop workspace stopped an idle Claude runtime after the turn had completed.',
        });
        closeClaudeQueryForRecovery(stopTarget);
        activeTurn = false;
        currentAbortController = null;
        stopped = false;
        emitStatus('closed_idle', 'Claude runtime stopped after completed turn.');
        return;
      }

      claudeInterruptRequested = true;
      claudeInterruptCompletionEmitted = false;
      try {
        if (!shouldInterruptCurrentClaudeTurn(stopTarget)) {
          emitEvent({
            type: 'lifecycle',
            stage: 'idle_stop',
            detail: 'Desktop workspace stopped an idle Claude runtime after the turn had completed.',
          });
          closeClaudeQueryForRecovery(stopTarget);
          emitStatus('closed_idle', 'Claude runtime stopped after completed turn.');
          return;
        }
        emitEvent({
          type: 'lifecycle',
          stage: 'interrupt_requested',
          detail: 'Claude interrupt requested by desktop workspace.',
        });
        await interruptClaudeWithTimeout(stopTarget.query);
        emitClaudeTurnInterrupted();
      } catch (error) {
        claudeInterruptRequested = false;
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.name === 'TimeoutError') {
          claudeLastSessionState = 'idle';
          resetClaudeTurnTracking();
          claudeTurnCompletionEmitted = true;
          claudeInterruptCompletionEmitted = true;
          emitEvent({
            type: 'stderr_line',
            line: `${message}; closing stuck Claude query.`,
          });
          emitEvent({
            type: 'lifecycle',
            stage: 'interrupt_timeout',
            detail: message,
          });
          closeClaudeQueryForRecovery(stopTarget);
          emitStatus('interrupted', 'Claude interrupt timed out; runtime will reconnect on the next prompt.');
        } else {
          emitEvent({
            type: 'stderr_line',
            line: `Failed to interrupt Claude turn: ${message}`,
          });
          emitStatus('error', message);
        }
      } finally {
        activeTurn = false;
        currentAbortController = null;
        stopped = false;
      }
      return;
    }

    currentAbortController?.abort();

    // Tear down sessions so the next prompt starts a fresh turn.
    teardownCodexSession(false);
    activeTurn = false;
    currentAbortController = null;
    stopped = false;

    emitStatus('ready', 'Turn interrupted. Ready for the next prompt.');
    return;
  }
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }

  let command: InputCommand;
  try {
    command = JSON.parse(line) as InputCommand;
  } catch (error) {
    emitEvent({
      type: 'stderr_line',
      line: `Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  void handleCommand(command).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    emitEvent({
      type: 'stderr_line',
      line: message,
    });
    emitStatus('error', message);
  });
});

rl.on('close', () => {
  if (!stopped) {
    emitStatus('stopped', 'Native runtime helper stdin closed.');
  }
});
