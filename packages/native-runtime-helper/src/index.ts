import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildClaudeQueryEnv } from './claudeEnv';
import { resolveClaudeInterruptTimeoutMs } from './claudeInterruptTimeout';
import { applyClaudePermissionModeToQuery } from './claudePermissionControl';
import { resolveClaudePermissionRequestId, type ClaudeToolPermissionOptions } from './claudePermissionRequests';
import { QuerySnapshotSlot, type QuerySnapshot } from './claudeQuerySnapshotSlot';
import { buildClaudePlanModeHooks } from './claudePlanGuard';
import { terminateOwnedProcessGroupOnParentClose } from './parentProcessTeardown';
import {
  buildClaudeRouterSystemPrompt,
  mergeClaudeRouteHooks,
  type ClaudeRouterInit,
} from './claudeRouteHook';
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
import { withSuppressedClaudeBypassShadowWarning } from './claudeSdkWarnings';
import {
  backgroundTaskSnapshotKey,
  ClaudeBackgroundTaskTracker,
  isBackgroundLaunchResult,
  type ClaudeBackgroundTask,
} from './claudeBackgroundTasks';

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
  router?: ClaudeRouterInit | null;
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
  request_id?: string;
  env_name?: string;
  perm_mode?: string;
  env_vars?: Record<string, string>;
  effort?: string;
  force_restart?: boolean;
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
  requestId?: string;
  envName?: string;
  permMode?: string;
  envVars?: Record<string, string>;
  effort?: string;
  forceRestart?: boolean;
};

type UsageQueryCommand = {
  type: 'usage_query';
};

type StopCommand = {
  type: 'stop';
  force_background_tasks?: boolean;
};

type InterruptTurnCommand = {
  type: 'interrupt_turn';
};

type PrepareStopCommand = {
  type: 'prepare_stop';
  request_id: string;
  require_idle?: boolean;
  force_background_tasks?: boolean;
  finalize?: boolean;
};

type CancelPrepareStopCommand = {
  type: 'cancel_prepare_stop';
  request_id: string;
};

type StopTaskCommand = {
  type: 'stop_task';
  task_id: string;
  stop_request_id: string;
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
  | UsageQueryCommand
  | InterruptTurnCommand
  | PrepareStopCommand
  | CancelPrepareStopCommand
  | StopTaskCommand
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
  | {
      type: 'teardown_prepared';
      request_id: string;
      ready: boolean;
      detail?: string;
    }
  | BrowserToolRequestOutput;

type PermissionResolver = {
  resolve: (approved: boolean) => void;
  agentId?: string;
  backgroundTaskId?: string;
};

type ClaudeInteractivePromptResolver = {
  input: Record<string, unknown>;
  agentId?: string;
  backgroundTaskId?: string;
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
let runtimeTeardownPreparationId: string | null = null;
let claudeSawPartialText = false;
let claudeSawPartialThinking = false;
let claudeTurnCompletionEmitted = false;
let claudeTurnAwaitingResult = false;
let claudeForegroundPromptUuid: string | null = null;
let claudeForegroundPromptAccepted = false;
let claudeIngressOriginKind: string | null = null;
let claudePendingNonHumanResultCount = 0;
const claudeSeenNonHumanResultKeys = new Set<string>();
let pendingClaudePromptReplay: {
  text: string;
  images?: PromptImage[] | null;
  messageUuid: string;
} | null = null;
const claudeSeenMessageIds = new Set<string>();
const claudeHiddenToolUseIds = new Set<string>();
let claudeContextUsageFailureKey: string | null = null;
let claudeSessionUsageKey: string | null = null;
let claudeSessionUsageFailureKey: string | null = null;
let claudeSessionUsageInFlight = false;
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
const claudeBackgroundTasks = new ClaudeBackgroundTaskTracker();
const claudeTaskProgressEmittedAt = new Map<string, number>();
let claudeBackgroundSnapshotKey = '';
const todoSnapshotTracker = new TodoSnapshotTracker();
const browserToolBridge = createBrowserToolBridge(
  (request) => emit(request),
  30_000,
  () => 'foreground',
);
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

function emitClaudeBackgroundTasksChanged(
  tasks = claudeBackgroundTasks.activeTasks(),
  force = false,
) {
  const key = backgroundTaskSnapshotKey(tasks);
  if (!force && key === claudeBackgroundSnapshotKey) {
    return false;
  }
  claudeBackgroundSnapshotKey = key;
  emitEvent({
    type: 'background_tasks_changed',
    tasks,
  });
  return true;
}

function emitClaudeBackgroundTaskUpdated(task: ClaudeBackgroundTask | null) {
  if (!task) {
    return;
  }
  emitEvent({
    type: 'background_task_updated',
    task,
  });
}

function completeClaudeBackgroundToolIfTerminal(task: ClaudeBackgroundTask | null) {
  if (!task?.tool_use_id
    || !['completed', 'failed', 'stopped', 'interrupted'].includes(task.status)) {
    return;
  }
  emitClaudeToolUseCompleted(
    task.tool_use_id,
    task.terminal_summary ?? task.error ?? `Background task ${task.status}.`,
    task.status === 'completed',
  );
}

function interruptClaudeBackgroundTasks(reason: string) {
  const interrupted = claudeBackgroundTasks.interruptAll(reason);
  interrupted.forEach((task) => {
    rejectBackgroundTaskInteractions(task.task_id, reason);
    emitClaudeBackgroundTaskUpdated(task);
    completeClaudeBackgroundToolIfTerminal(task);
  });
  if (interrupted.length > 0) {
    emitClaudeBackgroundTasksChanged([]);
  }
  claudeTaskProgressEmittedAt.clear();
  return interrupted;
}

function markClaudeToolUseBackgrounded(toolUseId: string) {
  claudeBackgroundTasks.markToolBackgroundCandidate(toolUseId);
  const taskId = claudeBackgroundTasks.taskIdForToolUse(toolUseId);
  if (!taskId) {
    return;
  }
  emitClaudeBackgroundTaskUpdated(claudeBackgroundTasks.getTask(taskId));
  emitClaudeBackgroundTasksChanged();
}

function applyPendingClaudeSettingsAfterBackgroundTaskChange() {
  if (applyPendingClaudeSettingsAfterTurn()) {
    emitStatus('ready', 'Settings applied.');
    return;
  }
  scheduleClaudeIdleClose();
}

function hasUnsettledClaudeBackgroundTasks() {
  return claudeBackgroundTasks.hasUnsettledTasks();
}

function claudeMessageOriginKind(message: unknown) {
  const origin = (message as { origin?: { kind?: unknown } } | undefined)?.origin;
  if (typeof origin?.kind === 'string') {
    return origin.kind;
  }

  const record = message as {
    type?: unknown;
    message?: { content?: unknown };
  } | undefined;
  if (record?.type !== 'user') {
    return null;
  }
  const content = record.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .filter((block): block is { type: 'text'; text: string } => Boolean(
          block
          && typeof block === 'object'
          && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string',
        ))
        .map((block) => block.text)
        .join('')
      : '';
  return /^\s*<task-notification>\s*<task-id>[^<]+<\/task-id>/u.test(text)
    ? 'task-notification'
    : null;
}

function isClaudeNonHumanIngress() {
  return claudeIngressOriginKind !== null && claudeIngressOriginKind !== 'human';
}

function claudeMessageParentToolUseId(message: unknown) {
  const parentToolUseId = (message as { parent_tool_use_id?: unknown } | undefined)
    ?.parent_tool_use_id;
  return typeof parentToolUseId === 'string' && parentToolUseId.trim()
    ? parentToolUseId.trim()
    : null;
}

function isClaudeBackgroundOwnedMessage(message: unknown) {
  const originKind = claudeMessageOriginKind(message);
  if (originKind && originKind !== 'human') {
    return true;
  }
  const parentToolUseId = claudeMessageParentToolUseId(message);
  if (parentToolUseId && (
    claudeBackgroundTasks.backgroundTaskIdForOwner(parentToolUseId)
    || claudeHiddenToolUseIds.has(parentToolUseId)
  )) {
    return true;
  }
  if (originKind === 'human') {
    return false;
  }
  // Assistant/stream frames do not carry origin. A preceding peer/channel/
  // coordinator user frame establishes their top-level turn owner until its
  // Result boundary. Background task notifications intentionally never set
  // this fallback, so they cannot hide an interleaved human stream.
  return isClaudeNonHumanIngress();
}

function propagateClaudeHiddenToolOwnership(message: unknown) {
  const record = message as {
    type?: unknown;
    tool_use_id?: unknown;
    task_id?: unknown;
    agent_id?: unknown;
    subagent_retry?: { agent_id?: unknown };
    message?: unknown;
  } | undefined;
  const parentToolUseId = claudeMessageParentToolUseId(message);
  const explicitTaskId = typeof record?.task_id === 'string'
    ? claudeBackgroundTasks.backgroundTaskIdForOwner(record.task_id)
    : null;
  const ownerTaskId = explicitTaskId
    ?? claudeBackgroundTasks.backgroundTaskIdForOwner(parentToolUseId);
  if (ownerTaskId) {
    const messageAgentId = typeof record?.agent_id === 'string'
      ? record.agent_id
      : typeof record?.subagent_retry?.agent_id === 'string'
        ? record.subagent_retry.agent_id
        : null;
    claudeBackgroundTasks.associateOwnerWithTask(messageAgentId, ownerTaskId);
  }
  if (record?.type === 'tool_progress' && typeof record.tool_use_id === 'string') {
    claudeHiddenToolUseIds.add(record.tool_use_id);
    if (ownerTaskId) {
      claudeBackgroundTasks.associateOwnerWithTask(record.tool_use_id, ownerTaskId);
      claudeBackgroundTasks.associateChildToolWithParent(record.tool_use_id, parentToolUseId);
    }
    return;
  }
  for (const block of getClaudeContentBlocks(record?.message)) {
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      claudeHiddenToolUseIds.add(block.id);
      if (ownerTaskId) {
        claudeBackgroundTasks.associateOwnerWithTask(block.id, ownerTaskId);
        claudeBackgroundTasks.associateChildToolWithParent(block.id, parentToolUseId);
      }
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      claudeHiddenToolUseIds.add(block.tool_use_id);
      if (ownerTaskId) {
        claudeBackgroundTasks.associateOwnerWithTask(block.tool_use_id, ownerTaskId);
        claudeBackgroundTasks.associateChildToolWithParent(block.tool_use_id, parentToolUseId);
      }
    }
  }
}

function resolveClaudeBackgroundTaskId(toolUseId?: string, agentId?: string) {
  const taskId = claudeBackgroundTasks.backgroundTaskIdForOwner(toolUseId)
    ?? claudeBackgroundTasks.backgroundTaskIdForOwner(agentId);
  if (taskId && agentId) {
    claudeBackgroundTasks.associateOwnerWithTask(agentId, taskId);
  }
  return taskId;
}

function isCurrentClaudeHumanPromptEcho(message: unknown) {
  if (claudeMessageOriginKind(message) !== 'human' || !claudeTurnAwaitingResult) {
    return false;
  }
  const messageUuid = (message as { uuid?: unknown } | undefined)?.uuid;
  if (typeof messageUuid === 'string' && claudeForegroundPromptUuid) {
    return messageUuid === claudeForegroundPromptUuid;
  }
  return true;
}

function claudeUserMessageHasToolResult(message: unknown) {
  const record = message as { message?: unknown } | undefined;
  return getClaudeContentBlocks(record?.message).some((block) => block.type === 'tool_result');
}

function claudeNonHumanResultKey(message: unknown, originKind: string | null) {
  const record = message as {
    uuid?: unknown;
    subtype?: unknown;
    result?: unknown;
    errors?: unknown;
  } | undefined;
  if (typeof record?.uuid === 'string' && record.uuid.trim()) {
    return `uuid:${record.uuid.trim()}`;
  }
  if (!originKind || originKind === 'human') {
    return null;
  }
  return JSON.stringify([
    originKind,
    record?.subtype ?? null,
    record?.result ?? null,
    record?.errors ?? null,
  ]);
}

function isForegroundClaudeResult(message: unknown) {
  if (!claudeTurnAwaitingResult) {
    return false;
  }
  const originKind = claudeMessageOriginKind(message);
  if (originKind && originKind !== 'human') {
    return false;
  }

  const resultPromptUuid = (message as { user_message_uuid?: unknown } | undefined)?.user_message_uuid;
  if (typeof resultPromptUuid === 'string' && claudeForegroundPromptUuid) {
    return resultPromptUuid === claudeForegroundPromptUuid;
  }

  if (originKind === 'human') {
    return claudeForegroundPromptAccepted;
  }

  if (claudePendingNonHumanResultCount > 0) {
    return false;
  }

  if (claudeIngressOriginKind && claudeIngressOriginKind !== 'human') {
    return false;
  }

  // Older SDK/CLI pairs omit both result fields. Their result is accepted only
  // after the matching human prompt echo has established foreground ownership.
  return claudeForegroundPromptAccepted;
}

function resolveClaudeIdleTtlMs() {
  const raw = process.env.CCEM_NATIVE_CLAUDE_IDLE_TTL_MS;
  if (raw == null || raw.trim() === '') {
    return DEFAULT_CLAUDE_IDLE_TTL_MS;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_CLAUDE_IDLE_TTL_MS;
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
  const timeoutMs = resolveClaudeInterruptTimeoutMs(
    process.env.CCEM_NATIVE_CLAUDE_INTERRUPT_TIMEOUT_MS,
  );
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
  claudeHiddenToolUseIds.clear();
}

function closeClaudeQueryForRecovery(
  snapshot = captureCurrentClaudeQuerySnapshot(),
  options: {
    interruptBackgroundTasks?: boolean;
    allowUnsafeClose?: boolean;
    reason?: string;
  } = {},
) {
  if (!options.allowUnsafeClose && !isClaudeForegroundAndSdkIdle()) {
    return false;
  }
  if (hasUnsettledClaudeBackgroundTasks() && options.interruptBackgroundTasks !== true) {
    return false;
  }

  if (hasUnsettledClaudeBackgroundTasks()) {
    interruptClaudeBackgroundTasks(options.reason ?? 'Claude query closed before the background task settled.');
  }
  clearClaudeIdleCloseTimer();
  pendingClaudePromptReplay = null;

  if (!snapshot) {
    return true;
  }

  if (isCurrentClaudeQuerySnapshot(snapshot)) {
    claudeTurnAwaitingResult = false;
    claudeForegroundPromptUuid = null;
    claudeForegroundPromptAccepted = false;
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
  return true;
}

function shouldInterruptCurrentClaudeTurn(
  snapshot: ClaudeQuerySnapshot | null = captureCurrentClaudeQuerySnapshot(),
): snapshot is ClaudeQuerySnapshot {
  return snapshot !== null
    && isCurrentClaudeQuerySnapshot(snapshot)
    && !claudeTurnCompletionEmitted
    && claudeTurnAwaitingResult;
}

function isClaudeForegroundAndSdkIdle() {
  return !claudeTurnAwaitingResult && claudeLastSessionState === 'idle';
}

function isClaudeRuntimeSafeToClose() {
  return isClaudeForegroundAndSdkIdle() && !hasUnsettledClaudeBackgroundTasks();
}

function scheduleClaudeIdleClose() {
  clearClaudeIdleCloseTimer();

  if (
    !currentClaudeQuery
    || !claudeInputQueue
    || initCommand?.provider !== 'claude'
    || !isClaudeRuntimeSafeToClose()
  ) {
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
    if (
      (!claudeTurnCompletionEmitted && !claudeInterruptCompletionEmitted)
      || !isClaudeRuntimeSafeToClose()
    ) {
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

function resetClaudeContentTracking() {
  claudeSawPartialText = false;
  claudeSawPartialThinking = false;
  claudeSeenMessageIds.clear();
}

function resetClaudeTurnTracking() {
  resetClaudeContentTracking();
  claudeTurnCompletionEmitted = false;
}

function emitClaudeTurnCompleted(detail: string) {
  if (claudeTurnCompletionEmitted) {
    return false;
  }

  claudeTurnCompletionEmitted = true;
  claudeForegroundPromptAccepted = false;
  claudeForegroundPromptUuid = null;
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
  claudeForegroundPromptAccepted = false;
  claudeForegroundPromptUuid = null;
  claudeLastSessionState = 'idle';
  claudeInterruptRequested = false;
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
  claudeForegroundPromptUuid = null;
  claudeForegroundPromptAccepted = false;
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
    if (payload.input.run_in_background === true) {
      claudeBackgroundTasks.markToolBackgroundCandidate(payload.toolUseId);
    }
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
  agentId?: string,
) {
  return await new Promise<ReturnType<typeof buildAllowedClaudeToolResult> | {
    behavior: 'deny';
    message: string;
    toolUseID: string;
  }>((resolve) => {
    pendingClaudeInteractivePrompts.set(toolUseId, {
      input,
      resolve,
      agentId,
    });
  });
}

async function waitForPlanExitApproval(
  input: Record<string, unknown>,
  toolUseId: string,
  agentId?: string,
) {
  return await new Promise<ReturnType<typeof buildAllowedClaudeToolResult> | {
    behavior: 'deny';
    message: string;
    toolUseID: string;
  }>((resolve) => {
    pendingClaudeInteractivePrompts.set(toolUseId, {
      input,
      resolve,
      agentId,
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
  const backgroundTaskId = resolveClaudeBackgroundTaskId(toolUseId, options.agentID)
    ?? undefined;

  if (!backgroundTaskId) {
    emitClaudeToolUseStarted({
      toolUseId,
      rawName: toolName,
      inputSummary,
      needsResponse: false,
      input,
    });
  }
  emitEvent({
    type: 'permission_required',
    request_id: requestId,
    tool_use_id: toolUseId,
    tool_name: formatPermissionPreview(options.displayName || toolName, 80),
    input_summary: inputSummary,
    ...(backgroundTaskId ? { background_task_id: backgroundTaskId } : {}),
  });

  const approved = await new Promise<boolean>((resolve) => {
    pendingPermissions.set(requestId, {
      resolve,
      agentId: options.agentID,
      backgroundTaskId,
    });
  });

  emitEvent({
    type: 'permission_responded',
    request_id: requestId,
    tool_use_id: toolUseId,
    approved,
    responder: 'desktop',
  });

  if (!approved && !backgroundTaskId) {
    emitClaudeToolUseCompleted(toolUseId, 'Permission denied in desktop workspace.', false);
  }

  return approved
    ? buildAllowedClaudeToolResult(input, toolUseId)
    : buildDeniedClaudeToolResult(toolUseId, 'Permission denied in desktop workspace.');
}

function handleClaudePartialEvent(
  rawEvent: Record<string, unknown>,
  backgroundOwned = false,
) {
  if (backgroundOwned) {
    return;
  }
  if (rawEvent.type === 'message_start') {
    resetClaudeContentTracking();
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
  void emitClaudeSessionUsage();
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

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

interface ClaudeSessionUsageModelEntry {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number | null;
}

interface ClaudeSessionUsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number | null;
  model_usage: ClaudeSessionUsageModelEntry[];
  subscription_type: string | null;
  rate_limits_available: boolean;
  rate_limits: Record<string, unknown> | null;
}

function parseClaudeSessionUsagePayload(raw: unknown): ClaudeSessionUsageSnapshot | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const session = (raw as { session?: unknown }).session;
  if (!session || typeof session !== 'object') {
    return null;
  }

  const sessionRecord = session as Record<string, unknown>;
  const rawModelUsage = sessionRecord.model_usage;
  const modelUsageMap = rawModelUsage && typeof rawModelUsage === 'object'
    ? rawModelUsage as Record<string, unknown>
    : {};

  const modelEntries: ClaudeSessionUsageModelEntry[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let costUsd: number | null = null;

  for (const [model, usage] of Object.entries(modelUsageMap)) {
    if (!usage || typeof usage !== 'object') {
      continue;
    }

    const entry = usage as Record<string, unknown>;
    const entryInput = asNumber(entry.inputTokens);
    const entryOutput = asNumber(entry.outputTokens);
    const entryCacheRead = asNumber(entry.cacheReadInputTokens);
    const entryCacheCreation = asNumber(entry.cacheCreationInputTokens);

    inputTokens += entryInput;
    outputTokens += entryOutput;
    cacheReadTokens += entryCacheRead;
    cacheCreationTokens += entryCacheCreation;

    modelEntries.push({
      model,
      input_tokens: entryInput,
      output_tokens: entryOutput,
      cache_read_tokens: entryCacheRead,
      cache_creation_tokens: entryCacheCreation,
      cost_usd: asNullableNumber(entry.costUSD),
    });
  }

  // SDK session cost is authoritative when present; per-model costs are informational.
  costUsd = asNullableNumber(sessionRecord.total_cost_usd);

  modelEntries.sort((a, b) => b.input_tokens - a.input_tokens);

  const rateLimits = (raw as { rate_limits?: unknown }).rate_limits;
  const rateLimitsAvailable = (raw as { rate_limits_available?: unknown }).rate_limits_available === true;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    cost_usd: costUsd,
    model_usage: modelEntries,
    subscription_type: asNullableString((raw as { subscription_type?: unknown }).subscription_type),
    rate_limits_available: rateLimitsAvailable,
    rate_limits: rateLimits && typeof rateLimits === 'object'
      ? rateLimits as Record<string, unknown>
      : null,
  };
}

function stableRateLimitsKey(rateLimits: Record<string, unknown> | null): string {
  if (!rateLimits) {
    return 'none';
  }
  const windowKey = (raw: unknown): string => {
    if (!raw || typeof raw !== 'object') {
      return 'null';
    }
    const record = raw as Record<string, unknown>;
    return [record.utilization, record.resets_at ?? ''].join(':');
  };
  // Deterministic order so reordered SDK payloads don't change the key.
  return ['five_hour', 'seven_day']
    .map((name) => `${name}=${windowKey(rateLimits[name])}`)
    .join(',');
}

/**
 * Actively query the current Claude session for cumulative token usage, cache
 * hits, cost and claude.ai plan rate-limit utilization via the Agent SDK's
 * structured `/usage` API. Emits a `session_usage` event; degrades silently
 * (with a deduped lifecycle notice) when the SDK rejects the call.
 */
async function emitClaudeSessionUsage() {
  if (!currentClaudeQuery || claudeSessionUsageInFlight) return;
  claudeSessionUsageInFlight = true;
  try {
    const raw = await currentClaudeQuery
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    const snapshot = parseClaudeSessionUsagePayload(raw);
    if (!snapshot) {
      throw new Error('Claude session usage payload was not structured.');
    }

    claudeSessionUsageFailureKey = null;

    const key = [
      snapshot.input_tokens,
      snapshot.output_tokens,
      snapshot.cache_read_tokens,
      snapshot.cache_creation_tokens,
      snapshot.cost_usd,
      snapshot.model_usage.map((entry) => [
        entry.model,
        entry.input_tokens,
        entry.output_tokens,
        entry.cache_read_tokens,
        entry.cache_creation_tokens,
        entry.cost_usd,
      ].join(':')).join(','),
      stableRateLimitsKey(snapshot.rate_limits),
    ].join('|');
    if (key === claudeSessionUsageKey) {
      return;
    }
    claudeSessionUsageKey = key;

    emitEvent({
      type: 'session_usage',
      provider: 'claude',
      input_tokens: snapshot.input_tokens,
      output_tokens: snapshot.output_tokens,
      cache_read_tokens: snapshot.cache_read_tokens,
      cache_creation_tokens: snapshot.cache_creation_tokens,
      cost_usd: snapshot.cost_usd,
      model_usage: snapshot.model_usage,
      subscription_type: snapshot.subscription_type,
      rate_limits_available: snapshot.rate_limits_available,
      rate_limits: snapshot.rate_limits,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = `Claude session usage unavailable: ${message}`;
    if (detail === claudeSessionUsageFailureKey) {
      return;
    }
    claudeSessionUsageFailureKey = detail;
    emitEvent({
      type: 'lifecycle',
      stage: 'usage_unavailable',
      detail,
    });
  } finally {
    claudeSessionUsageInFlight = false;
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

async function waitForClaudeInterruptToSettle() {
  while (claudeInterruptRequested) {
    await sleep(10);
  }
}

function finishClaudeRuntimeTeardown() {
  queueMicrotask(() => {
    rl.close();
    process.stdin.destroy();
  });
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
  const applied = applySettingsToInitCommand(settings);
  if (applied && initCommand?.provider === 'claude') {
    emitClaudeRuntimeSettingsChanged('applied', settings.requestId);
  }
  return applied;
}

function applySettingsCommand(command: UpdateSettingsCommand) {
  const applied = applySettingsToInitCommand({
    requestId: command.request_id,
    envName: command.env_name,
    permMode: command.perm_mode,
    envVars: command.env_vars,
    effort: command.effort,
  });
  if (applied && initCommand?.provider === 'claude') {
    emitClaudeRuntimeSettingsChanged('applied', command.request_id);
  }
  return applied;
}

function emitClaudeRuntimeSettingsChanged(
  state: 'deferred' | 'applied',
  requestId?: string,
) {
  if (!initCommand || initCommand.provider !== 'claude') {
    return;
  }
  emitEvent({
    type: 'runtime_settings_changed',
    state,
    request_id: requestId ?? null,
    env_name: initCommand.env_name,
    effort: initCommand.effort ?? null,
    pending_env_name: state === 'deferred' ? pendingSettings?.envName ?? null : null,
    pending_effort: state === 'deferred' ? pendingSettings?.effort ?? null : null,
  });
}

function queuePendingSettings(command: UpdateSettingsCommand) {
  pendingSettings = {
    ...pendingSettings,
    ...(command.request_id !== undefined ? { requestId: command.request_id } : {}),
    ...(command.env_name !== undefined ? { envName: command.env_name } : {}),
    ...(command.perm_mode !== undefined ? { permMode: command.perm_mode } : {}),
    ...(command.env_vars !== undefined ? { envVars: command.env_vars } : {}),
    ...(command.effort !== undefined ? { effort: command.effort } : {}),
    ...(command.force_restart !== undefined ? { forceRestart: command.force_restart } : {}),
  };
  if (initCommand?.provider === 'claude') {
    emitClaudeRuntimeSettingsChanged('deferred', command.request_id);
  }
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

  const forceRestart = pendingSettings.forceRestart === true;
  if (!isClaudeForegroundAndSdkIdle()
    || (hasUnsettledClaudeBackgroundTasks() && !forceRestart)) {
    return false;
  }

  applyPendingSettingsToInitCommand();
  closeClaudeQueryForRecovery(captureCurrentClaudeQuerySnapshot(), {
    interruptBackgroundTasks: forceRestart,
    reason: 'Claude settings changed before the background task settled.',
  });
  return true;
}

function applyClaudeSettingsByRestartingIdleRuntime(command: UpdateSettingsCommand) {
  if (!isClaudeForegroundAndSdkIdle()) {
    return false;
  }

  if (hasUnsettledClaudeBackgroundTasks() && command.force_restart !== true) {
    return false;
  }

  applySettingsCommand(command);
  closeClaudeQueryForRecovery(captureCurrentClaudeQuerySnapshot(), {
    interruptBackgroundTasks: command.force_restart === true,
    reason: 'Claude settings changed before the background task settled.',
  });
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
    routerMode: Boolean(initCommand.router),
  });
  const model = resolveClaudeRuntimeModel(initCommand.env_vars);
  const routerSystemPrompt = buildClaudeRouterSystemPrompt(initCommand.router);

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
    ...(routerSystemPrompt ? { systemPrompt: routerSystemPrompt } : {}),
    hooks: mergeClaudeRouteHooks(
      buildClaudePlanModeHooks(
        () => initCommand?.provider === 'claude' && initCommand.perm_mode === 'plan',
      ),
      initCommand.router,
    ),
    canUseTool: async (toolName: string, input: unknown, options: ClaudeToolPermissionOptions) => {
      const backgroundTaskId = resolveClaudeBackgroundTaskId(
        options.toolUseID,
        options.agentID,
      );
      const browserToolName = toolName.startsWith('mcp__ccem-browser__')
        ? toolName.slice('mcp__ccem-browser__'.length) as Parameters<
          typeof browserToolBridge.recordOwner
        >[0]
        : null;
      const rememberBrowserOwner = <T extends { behavior: string }>(result: T) => {
        if (browserToolName && result.behavior === 'allow') {
          const owner = backgroundTaskId
            ? `background:${backgroundTaskId}`
            : 'foreground';
          browserToolBridge.recordOwner(
            browserToolName,
            input as Record<string, unknown>,
            owner,
          );
        }
        return result;
      };
      if (isClaudeAskUserQuestionTool(toolName)) {
        if (backgroundTaskId) {
          return buildDeniedClaudeToolResult(
            options.toolUseID,
            'Background tasks cannot pause the foreground workspace for user questions.',
          );
        }
        return waitForAskUserQuestionResponse(input, options.toolUseID, options.agentID);
      }
      if (isClaudePlanExitTool(toolName)) {
        if (backgroundTaskId) {
          return buildDeniedClaudeToolResult(
            options.toolUseID,
            'Background tasks cannot request foreground plan approval.',
          );
        }
        return waitForPlanExitApproval(input, options.toolUseID, options.agentID);
      }
      if (isClaudeInteractiveUserInputTool(toolName)) {
        return buildAllowedClaudeToolResult(input, options.toolUseID);
      }
      if (isBrowserEvaluateToolName(toolName)) {
        if (permission.allowDangerouslySkipPermissions || browserEvaluateApprovedForSession) {
          return rememberBrowserOwner(buildAllowedClaudeToolResult(input, options.toolUseID));
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
        return rememberBrowserOwner(result);
      }
      return rememberBrowserOwner(await waitForPermission(toolName, input, options));
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

function denyPendingForegroundPermissions() {
  for (const [requestId, pending] of pendingPermissions.entries()) {
    if (pending.backgroundTaskId) {
      continue;
    }
    pendingPermissions.delete(requestId);
    pending.resolve(false);
  }
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

function denyPendingForegroundClaudeInteractivePrompts(message: string) {
  for (const [toolUseId, pending] of pendingClaudeInteractivePrompts.entries()) {
    if (pending.backgroundTaskId) {
      continue;
    }
    pendingClaudeInteractivePrompts.delete(toolUseId);
    emitClaudeToolUseCompleted(toolUseId, message, false);
    pending.resolve({
      behavior: 'deny',
      message,
      toolUseID: toolUseId,
    });
  }
}

function rejectBackgroundTaskInteractions(taskId: string, message: string) {
  for (const [requestId, pending] of pendingPermissions.entries()) {
    if (pending.backgroundTaskId !== taskId) {
      continue;
    }
    pendingPermissions.delete(requestId);
    pending.resolve(false);
  }
  for (const [toolUseId, pending] of pendingClaudeInteractivePrompts.entries()) {
    if (pending.backgroundTaskId !== taskId) {
      continue;
    }
    pendingClaudeInteractivePrompts.delete(toolUseId);
    pending.resolve({
      behavior: 'deny',
      message,
      toolUseID: toolUseId,
    });
  }
  browserToolBridge.rejectOwned(
    `background:${taskId}`,
    message,
  );
}

function teardownClaudeSession() {
  browserToolBridge.rejectAll('Claude runtime session was closed before the browser tool completed.');
  browserEvaluateApprovedForSession = false;
  closeClaudeQueryForRecovery(captureCurrentClaudeQuerySnapshot(), {
    interruptBackgroundTasks: true,
    allowUnsafeClose: true,
    reason: 'Claude runtime session closed before the background task settled.',
  });
  clearAllClaudeQueryState();
  claudeConsumeLoop = null;
  claudeIngressOriginKind = null;
  claudePendingNonHumanResultCount = 0;
  claudeSeenNonHumanResultKeys.clear();
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
  const options = buildClaudeQueryOptions();
  const claudeQuery = withSuppressedClaudeBypassShadowWarning(options, () => query({
    prompt: inputQueue,
    options,
  }));
  const querySnapshot = claudeQuerySlot.activate(claudeQuery, inputQueue);
  currentClaudeQuery = querySnapshot.query;
  claudeInputQueue = querySnapshot.inputQueue;
  if (hasUnsettledClaudeBackgroundTasks()) {
    interruptClaudeBackgroundTasks('Claude query process was replaced before the background task settled.');
  }
  claudeIngressOriginKind = null;
  claudePendingNonHumanResultCount = 0;
  claudeSeenNonHumanResultKeys.clear();
  claudeHiddenToolUseIds.clear();
  emitClaudeBackgroundTasksChanged([], true);
  let incompleteResponse = false;

  try {
    for await (const message of claudeQuery) {
      if (!isCurrentClaudeQuerySnapshot(querySnapshot)) {
        continue;
      }
      const sessionId = (message as { session_id?: string } | undefined)?.session_id;
      if (sessionId) {
        emitSessionMeta(sessionId);
      }

      if (message.type === 'stream_event') {
        const event = (message as { event?: Record<string, unknown> }).event;
        if (event) {
          handleClaudePartialEvent(event, isClaudeBackgroundOwnedMessage(message));
        }
        continue;
      }

      if (message.type === 'assistant') {
        if (isClaudeBackgroundOwnedMessage(message)) {
          propagateClaudeHiddenToolOwnership(message);
          continue;
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
        const originKind = claudeMessageOriginKind(message);
        const shouldQuery = (message as { shouldQuery?: unknown }).shouldQuery !== false;
        const hasToolResult = claudeUserMessageHasToolResult(message);
        const currentHumanEcho = !hasToolResult && isCurrentClaudeHumanPromptEcho(message);
        if (originKind === 'human' && !hasToolResult && !currentHumanEcho) {
          // A stale human echo from an earlier prompt must not take ownership
          // of the current turn, create a checkpoint, or expose peer output.
          continue;
        }
        const backgroundOwned = isClaudeBackgroundOwnedMessage(message);
        if (originKind === 'human') {
          if (currentHumanEcho) {
            claudeIngressOriginKind = 'human';
          } else if (!backgroundOwned && claudeForegroundPromptAccepted) {
            claudeIngressOriginKind = 'human';
          }
        } else if (originKind) {
          if (shouldQuery || !claudeForegroundPromptAccepted) {
            claudeIngressOriginKind = originKind;
          }
          if (shouldQuery && originKind !== 'human') {
            claudePendingNonHumanResultCount += 1;
          }
        }
        if (currentHumanEcho) {
          claudeForegroundPromptAccepted = true;
          pendingClaudePromptReplay = null;
        }
        const checkpoint = backgroundOwned
          ? null
          : buildClaudeFileCheckpointEvent(message, currentProviderSessionId);
        if (checkpoint) {
          emitEvent(checkpoint);
        }
        if (backgroundOwned) {
          propagateClaudeHiddenToolOwnership(message);
          continue;
        }

        const contentBlocks = getClaudeContentBlocks(message.message);
        contentBlocks.forEach((block) => {
          if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
            return;
          }
          const success = block.is_error !== true;
          const rawName = startedToolNames.get(block.tool_use_id) ?? 'tool';
          const input = pendingClaudeToolInputs.get(block.tool_use_id);
          if (isBackgroundLaunchResult(rawName, input, message.tool_use_result, success)) {
            const task = claudeBackgroundTasks.applyLaunchReceipt(
              block.tool_use_id,
              rawName,
              input,
              message.tool_use_result,
            );
            if (task) {
              emitClaudeBackgroundTaskUpdated(task);
              emitClaudeBackgroundTasksChanged();
              completeClaudeBackgroundToolIfTerminal(task);
            } else {
              markClaudeToolUseBackgrounded(block.tool_use_id);
            }
            return;
          }
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
        if (isClaudeBackgroundOwnedMessage(message)) {
          propagateClaudeHiddenToolOwnership(message);
          continue;
        }
        emitClaudeToolUseStarted({
          toolUseId: message.tool_use_id,
          rawName: message.tool_name,
          inputSummary: `Running ${message.tool_name}`,
          needsResponse: false,
        });
        continue;
      }

      if (message.type === 'tool_use_summary') {
        if (isClaudeBackgroundOwnedMessage(message)) {
          continue;
        }
        for (const toolUseId of message.preceding_tool_use_ids) {
          if (
            claudeBackgroundTasks.isBackgroundToolUse(toolUseId)
            || claudeHiddenToolUseIds.has(toolUseId)
          ) {
            continue;
          }
          emitClaudeToolUseCompleted(toolUseId, message.summary, true);
        }
        continue;
      }

      if (message.type === 'system' && message.subtype === 'task_started') {
        const task = claudeBackgroundTasks.applyStarted(message);
        emitClaudeBackgroundTaskUpdated(task);
        completeClaudeBackgroundToolIfTerminal(task);
        if (task) {
          emitClaudeBackgroundTasksChanged();
        }
        continue;
      }

      if (message.type === 'system' && message.subtype === 'task_progress') {
        const task = claudeBackgroundTasks.applyProgress(message);
        if (task) {
          const lastEmittedAt = claudeTaskProgressEmittedAt.get(task.task_id) ?? 0;
          const now = Date.now();
          if (now - lastEmittedAt >= 1_000) {
            claudeTaskProgressEmittedAt.set(task.task_id, now);
            emitClaudeBackgroundTaskUpdated(task);
            emitClaudeBackgroundTasksChanged();
          }
          completeClaudeBackgroundToolIfTerminal(task);
        }
        continue;
      }

      if (message.type === 'system' && message.subtype === 'task_updated') {
        const task = claudeBackgroundTasks.applyUpdated(message);
        emitClaudeBackgroundTaskUpdated(task);
        if (task) {
          emitClaudeBackgroundTasksChanged();
          completeClaudeBackgroundToolIfTerminal(task);
          if (['completed', 'failed', 'stopped', 'interrupted'].includes(task.status)) {
            applyPendingClaudeSettingsAfterBackgroundTaskChange();
          }
        }
        continue;
      }

      if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
        const change = claudeBackgroundTasks.applySnapshot(message.tasks);
        const promotedTerminalTasks = change.changed.filter((task) =>
          ['completed', 'failed', 'stopped', 'interrupted'].includes(task.status));
        promotedTerminalTasks.forEach((task) => {
          emitClaudeBackgroundTaskUpdated(task);
          completeClaudeBackgroundToolIfTerminal(task);
        });
        emitClaudeBackgroundTasksChanged(change.tasks);
        if (promotedTerminalTasks.length > 0) {
          applyPendingClaudeSettingsAfterBackgroundTaskChange();
        }
        continue;
      }

      if (message.type === 'system' && message.subtype === 'task_notification') {
        const task = claudeBackgroundTasks.applyNotification(message);
        if (!task) {
          continue;
        }
        rejectBackgroundTaskInteractions(
          task.task_id,
          task.error ?? task.terminal_summary ?? `Background task ${task.status}.`,
        );
        if (claudeIngressOriginKind === 'task-notification') {
          claudeIngressOriginKind = null;
        }
        emitClaudeBackgroundTaskUpdated(task);
        emitClaudeBackgroundTasksChanged();
        claudeTaskProgressEmittedAt.delete(task.task_id);
        completeClaudeBackgroundToolIfTerminal(task);
        applyPendingClaudeSettingsAfterBackgroundTaskChange();
        continue;
      }

      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        if (isClaudeBackgroundOwnedMessage(message)) {
          continue;
        }
        handleClaudeCompactBoundary(message as Record<string, unknown>);
        continue;
      }

      if (message.type === 'system' && message.subtype === 'status') {
        if (isClaudeBackgroundOwnedMessage(message)) {
          continue;
        }
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
        const nonHumanStateIngress = isClaudeBackgroundOwnedMessage(message);
        if (message.state !== claudeLastSessionState) {
          if (
            message.state === 'running'
            && claudeTurnAwaitingResult
            && !nonHumanStateIngress
          ) {
            resetClaudeContentTracking();
            emitEvent({
              type: 'lifecycle',
              stage: 'turn_started',
              detail: 'Claude is processing a turn.',
            });
            emitStatus('processing', 'Claude is processing a turn.');
          }

          if (message.state === 'idle') {
            if (claudeInterruptRequested && !nonHumanStateIngress) {
              emitClaudeTurnInterrupted();
            }
          }
        }

        claudeLastSessionState = message.state;
        if (message.state === 'idle' && !claudeTurnAwaitingResult) {
          if (applyPendingClaudeSettingsAfterTurn()) {
            emitStatus('ready', 'Settings applied.');
          } else {
            scheduleClaudeIdleClose();
          }
        }

        continue;
      }

      if (message.type === 'result') {
        if (!isCurrentClaudeQuerySnapshot(querySnapshot)) {
          continue;
        }
        const resultOriginKind = claudeMessageOriginKind(message);
        const priorNonHumanResultKey = claudeNonHumanResultKey(message, resultOriginKind);
        if (priorNonHumanResultKey
          && claudeSeenNonHumanResultKeys.has(priorNonHumanResultKey)) {
          continue;
        }
        const foregroundResult = isForegroundClaudeResult(message);
        if (!foregroundResult) {
          const resultPromptUuid = (message as { user_message_uuid?: unknown }).user_message_uuid;
          const hasHumanProvenance = resultOriginKind === 'human'
            || (!resultOriginKind && typeof resultPromptUuid === 'string');
          // A mismatched or stale human Result is unrelated to the current
          // non-human queue and must have no lifecycle side effects.
          if (!hasHumanProvenance) {
            const resultKey = priorNonHumanResultKey;
            if (resultKey && claudeSeenNonHumanResultKeys.has(resultKey)) {
              continue;
            }
            if (resultKey) {
              claudeSeenNonHumanResultKeys.add(resultKey);
            }
            claudePendingNonHumanResultCount = Math.max(
              0,
              claudePendingNonHumanResultCount - 1,
            );
            claudeIngressOriginKind = null;
          }
          continue;
        }

        claudeIngressOriginKind = null;
        claudeTurnAwaitingResult = false;
        pendingClaudePromptReplay = null;
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
          emitClaudeTurnCompleted(message.result?.trim() ?? '');
          // Defer context usage fetch to next tick — SDK internal state may not
          // be fully updated until after the result message is consumed.
          await new Promise(resolve => setImmediate(resolve));
          await emitClaudeContextUsage();
          await emitClaudeSessionUsage();
        } else {
          const reason = message.errors?.join('\n') || message.subtype;
          emitClaudeTurnCompleted(reason);
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
    if (claudeQuerySlot.isCurrent(querySnapshot) && hasUnsettledClaudeBackgroundTasks()) {
      interruptClaudeBackgroundTasks('Claude query process ended before the background task settled.');
    }
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
  enqueueClaudePrompt(prompt.text, prompt.images, prompt.messageUuid);
}

async function ensureClaudePromptQueueReady() {
  clearClaudeIdleCloseTimer();
  await ensureClaudeSession();

  if (!claudeInputQueue) {
    await ensureClaudeSession();
  }
}

function enqueueClaudePrompt(
  text: string,
  images?: PromptImage[] | null,
  messageUuid = randomUUID(),
) {
  if (!claudeInputQueue) {
    throw new Error('Claude streaming input queue is not ready');
  }

  pendingClaudePromptReplay = { text, images, messageUuid };
  claudeInterruptRequested = false;
  claudeInterruptCompletionEmitted = false;
  claudeForegroundPromptUuid = messageUuid;
  claudeForegroundPromptAccepted = false;
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
    uuid: messageUuid as SDKUserMessage['uuid'],
    origin: { kind: 'human' },
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
  if (hasUnsettledClaudeBackgroundTasks()) {
    throw new Error('Cannot rewind files while Claude background tasks are still running or settling.');
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

  const options = buildClaudeQueryOptions();
  const rewindQuery = withSuppressedClaudeBypassShadowWarning(options, () => query({
    prompt: '',
    options,
  }));

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

function rejectForegroundInteractionsForInterrupt() {
  denyPendingForegroundPermissions();
  denyPendingForegroundClaudeInteractivePrompts(
    'Claude foreground turn was interrupted before user responded.',
  );
  browserToolBridge.rejectOwned(
    'foreground',
    'Claude foreground turn was interrupted before the browser tool completed.',
  );
}

function emitTeardownPrepared(requestId: string, ready: boolean, detail?: string) {
  emit({
    type: 'teardown_prepared',
    request_id: requestId,
    ready,
    ...(detail ? { detail } : {}),
  });
}

function emitClaudeBackgroundTaskStopFailed(
  taskId: string,
  stopRequestId: string,
  error: string,
) {
  emit({
    type: 'background_task_stop_failed',
    task_id: taskId,
    stop_request_id: stopRequestId,
    error,
  });
}

async function prepareNativeRuntimeStop(
  requestId: string,
  requireIdle = false,
  forceBackgroundTasks = false,
  finalize = false,
) {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId) {
    return;
  }
  if (runtimeTeardownPreparationId && runtimeTeardownPreparationId !== normalizedRequestId) {
    emitTeardownPrepared(
      normalizedRequestId,
      false,
      'Another native runtime close is already being prepared.',
    );
    return;
  }
  runtimeTeardownPreparationId = normalizedRequestId;

  if (initCommand?.provider === 'claude') {
    const hasBackgroundTasks = hasUnsettledClaudeBackgroundTasks();
    if (hasBackgroundTasks && !forceBackgroundTasks) {
      emitTeardownPrepared(
        normalizedRequestId,
        false,
        'Claude background tasks are still running.',
      );
      return;
    }

    if (requireIdle && (
      claudeTurnAwaitingResult
      || claudeInterruptRequested
      || claudeLastSessionState !== 'idle'
    )) {
      emitTeardownPrepared(
        normalizedRequestId,
        false,
        'Claude foreground turn must be idle before terminal handoff.',
      );
      return;
    }

    if (
      !claudeTurnAwaitingResult
      && !claudeInterruptRequested
      && claudeLastSessionState !== null
      && claudeLastSessionState !== 'idle'
    ) {
      emitTeardownPrepared(
        normalizedRequestId,
        false,
        'Claude SDK is not idle.',
      );
      return;
    }

    if (requireIdle) {
      // A forced handoff keeps existing background work alive while the new
      // terminal is being created. The final prepare closes the Query and
      // marks any remaining tasks interrupted only after that succeeds.
      if (!(hasBackgroundTasks && forceBackgroundTasks && !finalize)) {
        const frozen = closeClaudeQueryForRecovery(
          captureCurrentClaudeQuerySnapshot(),
          forceBackgroundTasks && finalize
            ? {
              interruptBackgroundTasks: true,
              reason: 'Terminal handoff interrupted the Claude background task before it settled.',
            }
            : {},
        );
        if (!frozen) {
          emitTeardownPrepared(
            normalizedRequestId,
            false,
            'Claude SDK could not be frozen for terminal handoff.',
          );
          return;
        }
      }
    }
  } else if (requireIdle && activeTurn) {
    emitTeardownPrepared(
      normalizedRequestId,
      false,
      'Codex foreground turn must finish before terminal handoff.',
    );
    return;
  }

  emitTeardownPrepared(normalizedRequestId, true);
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

  if (command.type === 'usage_query') {
    if (initCommand?.provider !== 'claude') {
      // Codex sessions have no SDK usage API — they stay event-derived.
      return;
    }
    try {
      // Rehydrate the Claude runtime when it idled out, then actively query.
      await ensureClaudeSession();
      if (currentClaudeQuery) {
        await emitClaudeContextUsage();
        await emitClaudeSessionUsage();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Report via lifecycle only — emitting a Status here would flip the
      // session record out of 'processing'/'interrupted' mid-turn.
      emitEvent({
        type: 'lifecycle',
        stage: 'usage_unavailable',
        detail: `Claude usage query failed: ${message}`,
      });
    }
    return;
  }

  if (command.type === 'prepare_stop') {
    await prepareNativeRuntimeStop(
      command.request_id,
      command.require_idle === true,
      command.force_background_tasks === true,
      command.finalize === true,
    );
    return;
  }

  if (command.type === 'cancel_prepare_stop') {
    if (runtimeTeardownPreparationId === command.request_id) {
      runtimeTeardownPreparationId = null;
      stopped = false;
      emitStatus(
        claudeTurnAwaitingResult || activeTurn ? 'processing' : 'ready',
        'Native runtime close was cancelled.',
      );
    }
    return;
  }

  if (command.type === 'update_settings') {
    if (!initCommand) return;

    if (command.perm_mode !== undefined) {
      browserEvaluateApprovedForSession = false;
    }

    if (isClaudePermissionOnlySettingsCommand(command)
      && await applyClaudePermissionSettingsCommand(command)) {
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
    if (runtimeTeardownPreparationId) {
      throw new Error('Native runtime is preparing to close and cannot accept a new prompt.');
    }
    if (initCommand?.provider === 'claude') {
      await waitForClaudeInterruptToSettle();
      if (stopped || runtimeTeardownPreparationId) {
        throw new Error('Claude runtime is stopping and cannot accept a new prompt.');
      }
      await ensureClaudePromptQueueReady();
      if (stopped || runtimeTeardownPreparationId) {
        throw new Error('Claude runtime is stopping and cannot accept a new prompt.');
      }
      enqueueClaudePrompt(command.text.trim(), command.images);
    } else {
      promptQueue.push({ text: command.text.trim(), images: command.images });
      await runQueuedTurns();
    }
    return;
  }

  if (command.type === 'stop_task') {
    const taskId = command.task_id.trim();
    const stopRequestId = command.stop_request_id.trim();
    const task = claudeBackgroundTasks.markStopping(taskId, stopRequestId);
    if (!task) {
      const reason = taskId
        ? `Background task ${taskId} is not running in this Claude process.`
        : 'Missing background task id.';
      emitEvent({
        type: 'lifecycle',
        stage: 'background_task_stop_failed',
        detail: reason,
      });
      emitClaudeBackgroundTaskStopFailed(taskId, stopRequestId, reason);
      return;
    }

    if (!currentClaudeQuery) {
      const reason = `Background task ${taskId} is not attached to a live Claude query.`;
      emitClaudeBackgroundTaskUpdated(
        claudeBackgroundTasks.restoreStopFailure(taskId, stopRequestId, reason),
      );
      emitClaudeBackgroundTasksChanged();
      emitEvent({
        type: 'lifecycle',
        stage: 'background_task_stop_failed',
        detail: reason,
      });
      return;
    }

    emitClaudeBackgroundTaskUpdated(task);
    emitClaudeBackgroundTasksChanged();
    try {
      await currentClaudeQuery.stopTask(taskId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      emitClaudeBackgroundTaskUpdated(
        claudeBackgroundTasks.restoreStopFailure(taskId, stopRequestId, reason),
      );
      emitClaudeBackgroundTasksChanged();
      emitEvent({
        type: 'lifecycle',
        stage: 'background_task_stop_failed',
        detail: reason,
      });
    }
    return;
  }

  if (command.type === 'stop' || command.type === 'interrupt_turn') {
    const runtimeTeardown = command.type === 'stop';
    const forceBackgroundTasks = runtimeTeardown
      && command.force_background_tasks === true;
    stopped = runtimeTeardown;
    if (runtimeTeardown) {
      runtimeTeardownPreparationId = null;
    }
    clearClaudeIdleCloseTimer();
    pendingClaudePromptReplay = null;

    if (initCommand?.provider === 'claude') {
      if (runtimeTeardown && hasUnsettledClaudeBackgroundTasks() && !forceBackgroundTasks) {
        stopped = false;
        emitEvent({
          type: 'lifecycle',
          stage: 'teardown_blocked',
          detail: 'Claude runtime teardown was blocked by active background tasks.',
        });
        emitStatus(
          claudeTurnAwaitingResult ? 'processing' : 'ready',
          'Claude background tasks are still running.',
        );
        return;
      }

      const stopTarget = captureCurrentClaudeQuerySnapshot();
      if (!shouldInterruptCurrentClaudeTurn(stopTarget)) {
        if (!runtimeTeardown) {
          stopped = false;
          emitEvent({
            type: 'lifecycle',
            stage: 'interrupt_ignored',
            detail: 'Claude has no active foreground turn to interrupt.',
          });
          emitStatus('ready', 'Ready for the next prompt.');
          return;
        }
        emitEvent({
          type: 'lifecycle',
          stage: 'idle_stop',
          detail: 'Desktop workspace stopped an idle Claude runtime after the turn had completed.',
        });
        denyPendingPermissions();
        denyPendingClaudeInteractivePrompts('Native runtime session was closed before user responded.');
        browserToolBridge.rejectAll('Native runtime session was closed before the browser tool completed.');
        closeClaudeQueryForRecovery(stopTarget, {
          interruptBackgroundTasks: forceBackgroundTasks,
          allowUnsafeClose: true,
          reason: 'Claude runtime was stopped before the background task settled.',
        });
        activeTurn = false;
        currentAbortController = null;
        emitStatus('closed_idle', 'Claude runtime stopped after completed turn.');
        finishClaudeRuntimeTeardown();
        return;
      }

      claudeInterruptRequested = true;
      claudeInterruptCompletionEmitted = false;
      if (!runtimeTeardown) {
        rejectForegroundInteractionsForInterrupt();
      }
      try {
        if (!shouldInterruptCurrentClaudeTurn(stopTarget)) {
          if (!runtimeTeardown) {
            emitStatus('ready', 'Ready for the next prompt.');
            return;
          }
          emitEvent({
            type: 'lifecycle',
            stage: 'idle_stop',
            detail: 'Desktop workspace stopped an idle Claude runtime after the turn had completed.',
          });
          denyPendingPermissions();
          denyPendingClaudeInteractivePrompts('Native runtime session was closed before user responded.');
          browserToolBridge.rejectAll('Native runtime session was closed before the browser tool completed.');
          closeClaudeQueryForRecovery(stopTarget, {
            interruptBackgroundTasks: forceBackgroundTasks,
            allowUnsafeClose: true,
            reason: 'Claude runtime was stopped before the background task settled.',
          });
          emitStatus('closed_idle', 'Claude runtime stopped after completed turn.');
          finishClaudeRuntimeTeardown();
          return;
        }
        emitEvent({
          type: 'lifecycle',
          stage: 'interrupt_requested',
          detail: 'Claude interrupt requested by desktop workspace.',
        });
        await interruptClaudeWithTimeout(stopTarget.query);
        emitClaudeTurnInterrupted();
        if (runtimeTeardown) {
          if (hasUnsettledClaudeBackgroundTasks() && !forceBackgroundTasks) {
            stopped = false;
            emitEvent({
              type: 'lifecycle',
              stage: 'teardown_blocked',
              detail: 'Claude runtime teardown was blocked by a background task started during interrupt.',
            });
            return;
          }
          denyPendingPermissions();
          denyPendingClaudeInteractivePrompts('Native runtime session was closed before user responded.');
          browserToolBridge.rejectAll('Native runtime session was closed before the browser tool completed.');
          closeClaudeQueryForRecovery(stopTarget, {
            interruptBackgroundTasks: forceBackgroundTasks,
            allowUnsafeClose: true,
            reason: 'Claude runtime was stopped before the background task settled.',
          });
          emitStatus('closed_idle', 'Claude runtime stopped after interrupting the active turn.');
          finishClaudeRuntimeTeardown();
        }
      } catch (error) {
        claudeInterruptRequested = false;
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.name === 'TimeoutError') {
          if (hasUnsettledClaudeBackgroundTasks() && !forceBackgroundTasks) {
            stopped = false;
            emitEvent({
              type: 'lifecycle',
              stage: 'interrupt_timeout_background_tasks_preserved',
              detail: `${message}; background tasks remain attached to the existing Claude query.`,
            });
            emitStatus('processing', 'Claude interrupt timed out; background tasks remain running.');
            return;
          }
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
          closeClaudeQueryForRecovery(stopTarget, {
            interruptBackgroundTasks: forceBackgroundTasks,
            allowUnsafeClose: true,
            reason: 'Claude runtime stop timed out before the background task settled.',
          });
          emitStatus('interrupted', 'Claude interrupt timed out; runtime will reconnect on the next prompt.');
          if (runtimeTeardown) {
            finishClaudeRuntimeTeardown();
          }
        } else {
          emitEvent({
            type: 'stderr_line',
            line: `Failed to interrupt Claude turn: ${message}`,
          });
          emitEvent({
            type: 'lifecycle',
            stage: 'interrupt_failed',
            detail: message,
          });
          if (!runtimeTeardown) {
            emitStatus(
              'processing',
              'Claude interrupt failed; the foreground turn and background tasks remain attached.',
            );
            return;
          }
          if (hasUnsettledClaudeBackgroundTasks() && !forceBackgroundTasks) {
            stopped = false;
            emitEvent({
              type: 'lifecycle',
              stage: 'teardown_blocked',
              detail: 'Claude runtime teardown was blocked after interrupt failed.',
            });
            emitStatus(
              'processing',
              'Claude runtime teardown was blocked; background tasks remain attached.',
            );
            return;
          }
          denyPendingPermissions();
          denyPendingClaudeInteractivePrompts('Native runtime session was closed before user responded.');
          browserToolBridge.rejectAll('Native runtime session was closed before the browser tool completed.');
          closeClaudeQueryForRecovery(stopTarget, {
            interruptBackgroundTasks: forceBackgroundTasks,
            allowUnsafeClose: true,
            reason: 'Claude runtime stop failed before the background task settled.',
          });
          emitStatus('closed_idle', 'Claude runtime closed after its interrupt request failed.');
          finishClaudeRuntimeTeardown();
        }
      } finally {
        activeTurn = false;
        currentAbortController = null;
        if (!runtimeTeardown) {
          stopped = false;
        }
      }
      return;
    }

    currentAbortController?.abort();

    // Tear down sessions so the next prompt starts a fresh turn.
    teardownCodexSession(false);
    activeTurn = false;
    currentAbortController = null;
    if (runtimeTeardown) {
      emitStatus('closed_idle', 'Codex runtime stopped.');
      finishClaudeRuntimeTeardown();
    } else {
      stopped = false;
      emitStatus('ready', 'Turn interrupted. Ready for the next prompt.');
    }
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
  // Desktop launches the helper as a dedicated Unix process-group leader. Once parent stdin is
  // gone, kill that owned group first: telemetry and SDK cleanup can throw or block on broken I/O.
  if (terminateOwnedProcessGroupOnParentClose()) {
    return;
  }
  if (!stopped) {
    emitStatus('stopped', 'Native runtime helper stdin closed.');
  }
  closeClaudeQueryForRecovery();
  teardownCodexSession(false);
  process.exit(0);
});
