import { forkSession, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
  BROWSER_TOOL_BRIDGE_TIMEOUT_MS,
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
import { createStreamEventCoalescer } from './streamEventCoalescer';

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
  initial_command_id?: string | null;
  initial_images?: PromptImage[] | null;
  provider_session_id?: string | null;
  fork_session?: boolean | null;
  fork_at_message_id?: string | null;
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
  command_id?: string;
};

type InteractivePromptResponseCommand = {
  type: 'interactive_prompt_response';
  control_request_id?: string;
  expected_query_generation?: number;
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
  permission_scope?: 'display' | 'runtime';
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
  permissionScope?: 'display' | 'runtime';
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
  expected_command_id?: string | null;
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
      capabilities?: string[];
      query_generation?: number;
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
      type: 'settings_update_result';
      request_id: string;
      outcome: 'applied' | 'failed' | 'deferred';
      detail?: string;
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

type ClaudeInteractivePromptResult = {
  behavior: 'allow';
  updatedInput: Record<string, unknown>;
  toolUseID: string;
} | {
  behavior: 'deny';
  message: string;
  toolUseID: string;
};

type ClaudeInteractivePromptResolver = {
  input: Record<string, unknown>;
  queryGeneration: number;
  promptType: 'ask_user_question' | 'plan_exit' | null;
  agentId?: string;
  backgroundTaskId?: string;
  promise: Promise<ClaudeInteractivePromptResult>;
  resolve: (result: ClaudeInteractivePromptResult) => void;
};

const DEFAULT_CLAUDE_IDLE_TTL_MS = 10 * 60 * 1000;
const CLAUDE_INCOMPLETE_RESPONSE_REASON = 'Claude response ended before a final result. Partial output was preserved; send the next prompt to retry.';

let initCommand: InitCommand | null = null;
let stopped = false;
let activeTurn = false;
let currentProviderSessionId: string | null = null;
let lastEmittedSessionMetaKey: string | null = null;
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
let claudeLastAssistantMessageUuid: string | null = null;
let claudeTurnAwaitingResult = false;
let claudeForegroundPromptUuid: string | null = null;
let claudeForegroundPromptAccepted = false;
let claudeForegroundCommand: 'compact' | null = null;
let claudeIngressOriginKind: string | null = null;
let claudePendingNonHumanResultCount = 0;
let claudeDeferredForegroundResult: { detail: string; failed: boolean } | null = null;
// Bumped every time a fresh Claude query (consume loop) is constructed inside
// this helper process. Orthogonal to the Rust-side helper process incarnation:
// a query restart keeps the same incarnation; a helper restart resets it.
let claudeQueryGeneration = 0;
type ClaudeLifecycleMode = 'negotiating' | 'full' | 'legacy' | 'poisoned';
type ClaudeSdkCommandState = 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded' | 'refused';
type ClaudeSdkCommandLifecycleFrame = {
  commandId: string;
  state: string;
};
type ClaudeTurnResultObservation = {
  commandId: string;
  detail: string;
  failed: boolean;
};
let claudeLifecycleMode: ClaudeLifecycleMode = 'negotiating';
// `undefined` means capability negotiation is still in progress. An explicit
// empty list is the negotiated LegacySerial adapter.
let claudeSdkCapabilities: string[] | undefined;
let claudePreInitLifecycleFrames: ClaudeSdkCommandLifecycleFrame[] = [];
let claudeTurnResultObservation: ClaudeTurnResultObservation | null = null;
let claudeLegacyIdleCommandId: string | null = null;
let claudeLifecycleTerminalTimer: ReturnType<typeof setTimeout> | null = null;
let claudeLifecycleProtocolErrorKey: string | null = null;
let claudeAuthoritativeTerminalCommandId: string | null = null;
let claudeForegroundCoordinatorStamped = false;
let pendingClaudeCoordinatorAdmission: {
  commandId: string;
} | null = null;
const cancelledClaudeCoordinatorAdmissions = new Set<string>();
const initializationRejectedClaudeAdmissions = new Set<string>();
let claudeInitializationPending = false;
let claudeInitializationError: string | null = null;
let resolveClaudeInitialization: (() => void) | null = null;
let claudeInitializationBarrier: Promise<void> = Promise.resolve();
const claudeTerminalCommandIds = new Set<string>();
const claudeObservedResultCommandIds = new Set<string>();
const claudeSeenNonHumanResultKeys = new Set<string>();
let pendingClaudePromptReplay: {
  text: string;
  images?: PromptImage[] | null;
  messageUuid: string;
  coordinatorStamped: boolean;
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
  BROWSER_TOOL_BRIDGE_TIMEOUT_MS,
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

function writeOutput(output: HelperOutput) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

const streamEventCoalescer = createStreamEventCoalescer((payload) => {
  writeOutput({ type: 'event', payload });
});

function emit(output: HelperOutput) {
  streamEventCoalescer.flush();
  writeOutput(output);
}

function emitStatus(status: string, detail?: string) {
  emit({ type: 'status', status, detail });
}

function emitSettingsUpdateResult(
  requestId: string | undefined,
  outcome: 'applied' | 'failed' | 'deferred',
  detail?: string,
) {
  // New desktop runtimes always provide a correlation id. Keep accepting
  // legacy commands without one, but do not emit an uncorrelatable ack.
  if (requestId === undefined) {
    return;
  }
  emit({
    type: 'settings_update_result',
    request_id: requestId,
    outcome,
    ...(detail ? { detail } : {}),
  });
}

function emitEvent(payload: Record<string, unknown>) {
  streamEventCoalescer.emit(payload);
}

function emitSessionMeta(providerSessionId: string) {
  if (!providerSessionId) {
    return;
  }
  currentProviderSessionId = providerSessionId;
  const claudeMeta = initCommand?.provider === 'claude';
  const capabilitiesMarker = !claudeMeta
    ? 'not-claude'
    : claudeSdkCapabilities === undefined
      ? 'negotiating'
      : JSON.stringify(claudeSdkCapabilities);
  const metaKey = claudeMeta
    ? `${providerSessionId}:${claudeQueryGeneration}:${capabilitiesMarker}`
    : providerSessionId;
  if (lastEmittedSessionMetaKey === metaKey) {
    return;
  }
  lastEmittedSessionMetaKey = metaKey;
  emit({
    type: 'session_meta',
    provider_session_id: providerSessionId,
    ...(claudeMeta
      ? {
          query_generation: claudeQueryGeneration,
          ...(claudeSdkCapabilities === undefined
            ? {}
            : { capabilities: claudeSdkCapabilities }),
        }
      : {}),
  });
}

const CLAUDE_SDK_COMMAND_STATES = new Set<ClaudeSdkCommandState>([
  'queued',
  'started',
  'completed',
  'cancelled',
  'discarded',
  'refused',
]);
const CLAUDE_SDK_TERMINAL_STATES = new Set<ClaudeSdkCommandState>([
  'completed',
  'cancelled',
  'discarded',
  'refused',
]);
const MAX_PRE_INIT_LIFECYCLE_FRAMES = 64;

function claudeLifecycleTerminalTimeoutMs() {
  const raw = Number(process.env.CCEM_NATIVE_LIFECYCLE_TERMINAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

function clearClaudeLifecycleTerminalTimer() {
  if (claudeLifecycleTerminalTimer) {
    clearTimeout(claudeLifecycleTerminalTimer);
    claudeLifecycleTerminalTimer = null;
  }
}

function emitClaudeLifecycleProtocolError(reason: string, commandId = claudeForegroundPromptUuid) {
  const errorKey = `${claudeQueryGeneration}:${commandId ?? ''}:${reason}`;
  if (claudeLifecycleProtocolErrorKey === errorKey) {
    return;
  }
  claudeLifecycleProtocolErrorKey = errorKey;
  claudeLifecycleMode = 'poisoned';
  clearClaudeLifecycleTerminalTimer();
  pendingClaudePromptReplay = null;
  emitEvent({
    type: 'lifecycle',
    stage: 'lifecycle_protocol_error',
    detail: reason,
    query_generation: claudeQueryGeneration,
    ...(commandId ? { command_id: commandId } : {}),
  });
  emitStatus('error', reason);
}

function emitClaudeInteractiveResolverExpired(
  toolUseId: string,
  pending: ClaudeInteractivePromptResolver,
  command?: InteractivePromptResponseCommand,
) {
  emitEvent({
    type: 'interactive_response_result',
    tool_use_id: toolUseId,
    ...(command ? { prompt_type: command.prompt_type } : {}),
    state: 'resolver_expired',
    ...(command
      ? interactiveResponseCorrelation(command, pending.queryGeneration)
      : { query_generation: pending.queryGeneration }),
  });
}

function beginClaudeLifecycleGeneration() {
  for (const [toolUseId, pending] of pendingClaudeInteractivePrompts.entries()) {
    if (pending.queryGeneration === claudeQueryGeneration) {
      continue;
    }
    emitClaudeInteractiveResolverExpired(toolUseId, pending);
    pendingClaudeInteractivePrompts.delete(toolUseId);
    startedToolNames.delete(toolUseId);
    pendingClaudeToolInputs.delete(toolUseId);
    completedToolUseIds.delete(toolUseId);
    pending.resolve({
      behavior: 'deny',
      message: 'Claude query generation changed before the user prompt was answered.',
      toolUseID: toolUseId,
    });
  }
  clearClaudeLifecycleTerminalTimer();
  claudeLifecycleMode = 'negotiating';
  claudeSdkCapabilities = undefined;
  claudePreInitLifecycleFrames = [];
  claudeLifecycleProtocolErrorKey = null;
  claudeAuthoritativeTerminalCommandId = null;
  claudeTerminalCommandIds.clear();
  claudeObservedResultCommandIds.clear();
  if (currentProviderSessionId) {
    emitSessionMeta(currentProviderSessionId);
  }
}

function armClaudeLifecycleTerminalTimer(commandId: string, reason: string) {
  clearClaudeLifecycleTerminalTimer();
  const generation = claudeQueryGeneration;
  claudeLifecycleTerminalTimer = setTimeout(() => {
    claudeLifecycleTerminalTimer = null;
    if (
      claudeLifecycleMode === 'full'
      && claudeTurnAwaitingResult
      && claudeForegroundPromptUuid === commandId
      && claudeQueryGeneration === generation
    ) {
      emitClaudeLifecycleProtocolError(
        reason,
        commandId,
      );
    }
  }, claudeLifecycleTerminalTimeoutMs());
  claudeLifecycleTerminalTimer.unref?.();
}

function configureClaudeLifecycleFromInit(message: unknown) {
  const record = message as {
    capabilities?: unknown;
    session_id?: unknown;
  };
  if (!Array.isArray(record.capabilities)) {
    // An absent capability field is not an explicit LegacySerial handshake.
    // Keep this query negotiating until the SDK provides an actual list.
    return;
  }
  const capabilities = record.capabilities.filter(
    (capability): capability is string => typeof capability === 'string',
  );
  const nextMode: ClaudeLifecycleMode = capabilities.includes('msg_lifecycle_v1')
    ? 'full'
    : 'legacy';

  if (
    claudeLifecycleMode !== 'negotiating'
    && claudeLifecycleMode !== 'poisoned'
    && claudeLifecycleMode !== nextMode
  ) {
    emitClaudeLifecycleProtocolError(
      `capability_changed_within_query: ${claudeLifecycleMode} -> ${nextMode}`,
    );
    return;
  }
  if (claudeLifecycleMode === 'poisoned') {
    return;
  }

  claudeSdkCapabilities = capabilities;
  claudeLifecycleMode = nextMode;
  const sessionId = typeof record.session_id === 'string' ? record.session_id : null;
  if (sessionId) {
    emitSessionMeta(sessionId);
  }

  const buffered = claudePreInitLifecycleFrames;
  claudePreInitLifecycleFrames = [];
  if (nextMode === 'full') {
    buffered.forEach(processNegotiatedClaudeSdkCommandLifecycle);
  } else if (buffered.length > 0) {
    const matching = buffered.find((frame) => frame.commandId === claudeForegroundPromptUuid);
    emitClaudeLifecycleProtocolError(
      'lifecycle_frames_without_capability: LegacySerial init followed pre-init command lifecycle frames',
      matching?.commandId,
    );
  }
}

function processNegotiatedClaudeSdkCommandLifecycle(frame: ClaudeSdkCommandLifecycleFrame) {
  if (claudeLifecycleMode !== 'full') {
    return;
  }
  const matchingForeground = claudeTurnAwaitingResult
    && claudeForegroundPromptUuid === frame.commandId;
  if (!CLAUDE_SDK_COMMAND_STATES.has(frame.state as ClaudeSdkCommandState)) {
    if (matchingForeground) {
      emitClaudeLifecycleProtocolError(`unknown_sdk_command_state: ${frame.state}`, frame.commandId);
    }
    return;
  }

  const state = frame.state as ClaudeSdkCommandState;
  emitEvent({
    type: 'lifecycle',
    stage: 'sdk_command_state',
    detail: state,
    command_id: frame.commandId,
    query_generation: claudeQueryGeneration,
  });
  if (!matchingForeground) {
    return;
  }
  if (state === 'queued' || state === 'started') {
    claudeForegroundPromptAccepted = true;
    pendingClaudePromptReplay = null;
    return;
  }
  if (CLAUDE_SDK_TERMINAL_STATES.has(state)) {
    finishClaudeFullLifecycleTurn(state, frame.commandId);
  }
}

function handleClaudeSdkCommandLifecycle(message: unknown) {
  const record = message as {
    command_uuid?: unknown;
    state?: unknown;
    session_id?: unknown;
  };
  if (typeof record.command_uuid !== 'string') {
    return;
  }
  if (typeof record.state !== 'string') {
    if (record.command_uuid === claudeForegroundPromptUuid) {
      emitClaudeLifecycleProtocolError(
        'malformed_sdk_command_state: matching lifecycle frame omitted a string state',
        record.command_uuid,
      );
    }
    return;
  }
  if (typeof record.session_id === 'string') {
    emitSessionMeta(record.session_id);
  }
  const frame = { commandId: record.command_uuid, state: record.state };
  if (claudeLifecycleMode === 'negotiating') {
    if (claudePreInitLifecycleFrames.length >= MAX_PRE_INIT_LIFECYCLE_FRAMES) {
      if (record.command_uuid === claudeForegroundPromptUuid) {
        emitClaudeLifecycleProtocolError('pre_init_lifecycle_buffer_overflow', record.command_uuid);
      }
      return;
    }
    claudePreInitLifecycleFrames.push(frame);
    return;
  }
  processNegotiatedClaudeSdkCommandLifecycle(frame);
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
  // Result boundary. Task notifications may establish that fallback only
  // outside an accepted foreground human turn.
  return isClaudeNonHumanIngress();
}

function taskNotificationSharesActiveForegroundTurn(originKind: string) {
  return originKind === 'task-notification'
    && claudeTurnAwaitingResult
    && claudeForegroundPromptAccepted
    && (claudeIngressOriginKind === null || claudeIngressOriginKind === 'human');
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
    claudeForegroundCommand = null;
    claudeDeferredForegroundResult = null;
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
  return !claudeTurnAwaitingResult
    && (
      claudeLastSessionState === 'idle'
      || claudeAuthoritativeTerminalCommandId !== null
    );
}

function canRestartClaudeRuntimeForSettings(forceRestart: boolean) {
  return !claudeTurnAwaitingResult
    && (
      forceRestart
      || claudeLastSessionState === 'idle'
      || claudeAuthoritativeTerminalCommandId !== null
    );
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
  clearClaudeLifecycleTerminalTimer();
  resetClaudeContentTracking();
  claudeTurnCompletionEmitted = false;
  claudeLastAssistantMessageUuid = null;
  claudeDeferredForegroundResult = null;
  claudeTurnResultObservation = null;
  claudeLegacyIdleCommandId = null;
}

function clearClaudeForegroundOwnership() {
  clearClaudeLifecycleTerminalTimer();
  claudeTurnAwaitingResult = false;
  pendingClaudePromptReplay = null;
  claudeForegroundPromptAccepted = false;
  claudeForegroundPromptUuid = null;
  claudeForegroundCommand = null;
  claudeForegroundCoordinatorStamped = false;
  claudeDeferredForegroundResult = null;
  claudeIngressOriginKind = null;
  claudePendingNonHumanResultCount = 0;
}

function rememberClaudeCommandId(set: Set<string>, commandId: string) {
  set.add(commandId);
  if (set.size <= 64) {
    return;
  }
  const oldest = set.values().next().value;
  if (typeof oldest === 'string') {
    set.delete(oldest);
  }
}

function emitClaudeResultUsage(message: unknown) {
  const record = message as {
    usage?: Record<string, unknown>;
    total_cost_usd?: number;
  };
  if (!record.usage) {
    return;
  }
  const outputTokens = typeof record.usage.output_tokens === 'number'
    ? record.usage.output_tokens
    : 0;
  emitEvent({
    type: 'token_usage',
    provider: 'claude',
    input_tokens: typeof record.usage.input_tokens === 'number' ? record.usage.input_tokens : 0,
    output_tokens: outputTokens,
    cache_read_tokens: typeof record.usage.cache_read_input_tokens === 'number'
      ? record.usage.cache_read_input_tokens
      : 0,
    cache_creation_tokens: typeof record.usage.cache_creation_input_tokens === 'number'
      ? record.usage.cache_creation_input_tokens
      : 0,
    total_cost_usd: typeof record.total_cost_usd === 'number' ? record.total_cost_usd : null,
    scope: 'turn_total',
  });
}

function claudeResultObservation(message: {
  subtype: string;
  errors?: string[];
  result?: string;
}) {
  const failed = message.subtype !== 'success';
  return {
    failed,
    detail: failed
      ? message.errors?.join('\n') || message.subtype
      : message.result?.trim() ?? '',
  };
}

function observeLateClaudeTurnResult(
  commandId: string,
  detail: string,
  failed: boolean,
) {
  if (claudeObservedResultCommandIds.has(commandId)) {
    return false;
  }
  rememberClaudeCommandId(claudeObservedResultCommandIds, commandId);
  emitEvent({
    type: 'lifecycle',
    stage: 'turn_result_observed',
    detail,
    command_id: commandId,
    query_generation: claudeQueryGeneration,
  });
  if (!failed) {
    emitClaudeUsageAfterTurn();
  }
  return true;
}

function emitClaudeLegacyTurnTerminal(detail: string) {
  if (claudeTurnCompletionEmitted) {
    return false;
  }

  claudeTurnCompletionEmitted = true;
  const completedCommandId = claudeForegroundPromptUuid;
  clearClaudeForegroundOwnership();
  emitEvent({
    type: 'lifecycle',
    stage: 'legacy_turn_terminal',
    detail,
    query_generation: claudeQueryGeneration,
    ...(completedCommandId
      ? { command_id: completedCommandId, user_message_uuid: completedCommandId }
      : {}),
    ...(claudeLastAssistantMessageUuid
      ? { assistant_message_uuid: claudeLastAssistantMessageUuid }
      : {}),
  });
  // Compatibility projection for older helper-only consumers. It is emitted
  // at the exact same LegacySerial terminal boundary, never from FullLifecycle.
  emitEvent({
    type: 'lifecycle',
    stage: 'turn_completed',
    detail,
    query_generation: claudeQueryGeneration,
    ...(completedCommandId ? { command_id: completedCommandId } : {}),
    ...(claudeLastAssistantMessageUuid
      ? { assistant_message_uuid: claudeLastAssistantMessageUuid }
      : {}),
  });
  if (applyPendingClaudeSettingsAfterTurn()) {
    emitStatus('ready', 'Settings applied.');
    return true;
  }
  emitStatus('ready', 'Ready for the next prompt.');
  scheduleClaudeIdleClose();
  return true;
}

function finishClaudeFullLifecycleTurn(state: ClaudeSdkCommandState, commandId: string) {
  if (
    claudeLifecycleMode !== 'full'
    || !claudeTurnAwaitingResult
    || claudeForegroundPromptUuid !== commandId
  ) {
    return false;
  }

  const observation = claudeTurnResultObservation;
  const interruptedByRequest = claudeInterruptRequested;
  claudeTurnCompletionEmitted = true;
  claudeAuthoritativeTerminalCommandId = commandId;
  rememberClaudeCommandId(claudeTerminalCommandIds, commandId);
  clearClaudeForegroundOwnership();
  claudeInterruptRequested = false;

  if (interruptedByRequest && state !== 'completed' && !claudeInterruptCompletionEmitted) {
    claudeInterruptCompletionEmitted = true;
    emitEvent({
      type: 'lifecycle',
      stage: 'turn_interrupted',
      detail: `Claude command ${state} after the interrupt request.`,
      query_generation: claudeQueryGeneration,
      command_id: commandId,
      user_message_uuid: commandId,
      ...(claudeLastAssistantMessageUuid
        ? { assistant_message_uuid: claudeLastAssistantMessageUuid }
        : {}),
    });
  }

  if (observation?.failed) {
    emitEvent({
      type: 'session_completed',
      reason: observation.detail,
      command_id: commandId,
    });
  }
  if (applyPendingClaudeSettingsAfterTurn()) {
    emitStatus('ready', 'Settings applied.');
    return true;
  }
  if (pendingSettings) {
    emitStatus('processing', 'Settings will apply to the next Claude runtime.');
    return true;
  }
  const detail = interruptedByRequest && state !== 'completed'
    ? 'Turn interrupted. Ready for the next prompt.'
    : state === 'completed'
    ? 'Ready for the next prompt.'
    : `Claude command ${state}. Ready for the next prompt.`;
  emitStatus('ready', detail);
  scheduleClaudeIdleClose();
  return true;
}

function observeClaudeTurnResult(detail: string, failed: boolean) {
  const commandId = claudeForegroundPromptUuid;
  if (!claudeTurnAwaitingResult || !commandId) {
    return false;
  }
  claudeTurnResultObservation = { commandId, detail, failed };
  rememberClaudeCommandId(claudeObservedResultCommandIds, commandId);
  emitEvent({
    type: 'lifecycle',
    stage: 'turn_result_observed',
    detail,
    command_id: commandId,
    query_generation: claudeQueryGeneration,
  });
  if (claudeLifecycleMode === 'full') {
    armClaudeLifecycleTerminalTimer(
      commandId,
      'missing_terminal_after_result: lifecycle-capable Claude query did not emit a matching terminal state',
    );
  }
  return true;
}

function finishClaudeLegacyTurnAfterIdle() {
  if (
    claudeLifecycleMode !== 'legacy'
    || !claudeTurnAwaitingResult
    || !claudeTurnResultObservation
    || claudeLegacyIdleCommandId !== claudeForegroundPromptUuid
  ) {
    return false;
  }
  const observation = claudeTurnResultObservation;
  const emitted = emitClaudeLegacyTurnTerminal(observation.detail);
  if (!emitted) {
    return false;
  }
  if (observation.failed) {
    emitEvent({
      type: 'session_completed',
      reason: observation.detail,
      command_id: observation.commandId,
    });
  }
  return true;
}

function emitClaudeTurnInterrupted(detail = 'Claude turn interrupted by desktop workspace.') {
  const interruptedCommandId = claudeForegroundPromptUuid;
  clearClaudeForegroundOwnership();
  claudeLastSessionState = 'idle';
  claudeInterruptRequested = false;
  resetClaudeTurnTracking();
  claudeTurnCompletionEmitted = true;
  if (claudeLifecycleMode === 'legacy' && interruptedCommandId) {
    emitEvent({
      type: 'lifecycle',
      stage: 'legacy_turn_terminal',
      detail,
      command_id: interruptedCommandId,
      user_message_uuid: interruptedCommandId,
      query_generation: claudeQueryGeneration,
      ...(claudeLastAssistantMessageUuid
        ? { assistant_message_uuid: claudeLastAssistantMessageUuid }
        : {}),
    });
  }
  if (!claudeInterruptCompletionEmitted) {
    claudeInterruptCompletionEmitted = true;
    emitEvent({
      type: 'lifecycle',
      stage: 'turn_interrupted',
      detail,
      query_generation: claudeQueryGeneration,
      ...(interruptedCommandId
        ? { command_id: interruptedCommandId, user_message_uuid: interruptedCommandId }
        : {}),
      ...(claudeLastAssistantMessageUuid
        ? { assistant_message_uuid: claudeLastAssistantMessageUuid }
        : {}),
    });
  }
  if (applyPendingClaudeSettingsAfterTurn()) {
    emitStatus('ready', 'Settings applied.');
    return;
  }
  emitStatus('ready', 'Turn interrupted. Ready for the next prompt.');
  scheduleClaudeIdleClose();
}

function emitClaudeDeliveryUncertain(reason: string) {
  if (!claudeTurnAwaitingResult || !claudeForegroundPromptUuid) {
    return false;
  }
  const commandId = claudeForegroundPromptUuid;
  const eventKey = `${claudeQueryGeneration}:${commandId}:delivery_uncertain`;
  if (claudeLifecycleProtocolErrorKey === eventKey) {
    return false;
  }
  claudeLifecycleProtocolErrorKey = eventKey;
  claudeLifecycleMode = 'poisoned';
  clearClaudeLifecycleTerminalTimer();
  pendingClaudePromptReplay = null;
  emitEvent({
    type: 'lifecycle',
    stage: 'delivery_uncertain',
    detail: reason,
    command_id: commandId,
    query_generation: claudeQueryGeneration,
  });
  emitStatus('error', reason);
  return true;
}

function emitClaudeIncompleteResponse() {
  if (!claudeTurnAwaitingResult) {
    return false;
  }

  if (claudeForegroundCoordinatorStamped) {
    return emitClaudeDeliveryUncertain(CLAUDE_INCOMPLETE_RESPONSE_REASON);
  }

  claudeTurnAwaitingResult = false;
  const incompleteCommandId = claudeForegroundPromptUuid;
  claudeForegroundPromptUuid = null;
  claudeForegroundPromptAccepted = false;
  claudeForegroundCommand = null;
  claudeDeferredForegroundResult = null;
  claudeLastSessionState = 'idle';
  claudeTurnCompletionEmitted = true;
  emitEvent({
    type: 'session_completed',
    reason: CLAUDE_INCOMPLETE_RESPONSE_REASON,
    ...(incompleteCommandId ? { command_id: incompleteCommandId } : {}),
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

  if (completedToolUseIds.has(payload.toolUseId)) {
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

function interactiveResponseCorrelation(
  command: InteractivePromptResponseCommand,
  queryGeneration: number,
) {
  return {
    control_request_id: command.control_request_id ?? null,
    query_generation: queryGeneration,
  };
}

function summarizePlanExitFeedback(answers: Record<string, string>) {
  const feedback = answers.feedback?.trim()
    || Object.values(answers)
      .map((value) => value.trim())
      .find(Boolean)
    || 'Please revise the plan.';

  return truncateSummary(`User requested plan changes: ${feedback}`, 240);
}

function waitForClaudeInteractivePromptResponse(
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
  agentId?: string,
) {
  // canUseTool is the SDK's authoritative interactive control channel. Emit
  // from it so the desktop never depends on an assistant tool_use frame that
  // can arrive later or be routed away with background-owned stream content.
  const prompt = parseClaudeInteractiveToolPrompt(toolName, input);
  const promptType = prompt?.prompt_type === 'ask_user_question'
    || prompt?.prompt_type === 'plan_exit'
    ? prompt.prompt_type
    : null;
  const emitPrompt = () => emitClaudeToolUseStarted({
    toolUseId,
    rawName: toolName,
    inputSummary: summarizeClaudeToolInput(toolName, input),
    needsResponse: true,
    input,
    prompt,
  });

  const existing = pendingClaudeInteractivePrompts.get(toolUseId);
  if (existing?.queryGeneration === claudeQueryGeneration) {
    // Reconnect/reinitialize can redeliver a pending request with the same id.
    // Reuse its promise so one desktop answer resumes every SDK waiter.
    emitPrompt();
    return existing.promise;
  }
  if (existing) {
    emitClaudeInteractiveResolverExpired(toolUseId, existing);
    pendingClaudeInteractivePrompts.delete(toolUseId);
    startedToolNames.delete(toolUseId);
    pendingClaudeToolInputs.delete(toolUseId);
    completedToolUseIds.delete(toolUseId);
    existing.resolve({
      behavior: 'deny',
      message: 'Claude query generation changed before the user prompt was answered.',
      toolUseID: toolUseId,
    });
  }

  let resolvePrompt!: (result: ClaudeInteractivePromptResult) => void;
  const promise = new Promise<ClaudeInteractivePromptResult>((resolve) => {
    resolvePrompt = resolve;
  });
  pendingClaudeInteractivePrompts.set(toolUseId, {
    input,
    queryGeneration: claudeQueryGeneration,
    promptType,
    promise,
    resolve: resolvePrompt,
    agentId,
  });
  emitPrompt();
  return promise;
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

function completeClaudeManualCompactTurn() {
  if (
    claudeLifecycleMode !== 'legacy'
    || !claudeTurnAwaitingResult
    || claudeForegroundCommand !== 'compact'
    || claudeTurnCompletionEmitted
  ) {
    return false;
  }

  return observeClaudeTurnResult('', false);
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

  if (trigger === 'manual') {
    completeClaudeManualCompactTurn();
  }

  // Emit fresh context snapshot after compaction
  void emitClaudeContextUsage();
  void emitClaudeSessionUsage();
}

function claudeUsageDeadlineMs() {
  const raw = Number(process.env.CCEM_NATIVE_USAGE_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

function withUsageDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  const budgetMs = claudeUsageDeadlineMs();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${budgetMs}ms`));
    }, budgetMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// Usage probes must never sit on the consume/completion lane: they run with a
// bounded deadline and their failures degrade to lifecycle notices only.
function emitClaudeUsageAfterTurn() {
  void (async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await emitClaudeContextUsage();
    await emitClaudeSessionUsage();
  })().catch(() => {
    // Deadline/failure here must never affect turn ownership — the lifecycle
    // notices are emitted by the individual emitters on failure.
  });
}

async function emitClaudeContextUsage() {
  if (!currentClaudeQuery) return;
  try {
    const queryForUsage = currentClaudeQuery;
    const ctx = await withUsageDeadline(queryForUsage.getContextUsage(), 'Claude context usage');
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
    const queryForUsage = currentClaudeQuery;
    const raw = await withUsageDeadline(
      queryForUsage.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      'Claude session usage',
    );
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
    const detail = 'Claude compacted the context.';
    emitEvent({
      type: 'lifecycle',
      stage: 'compact_completed',
      detail,
    });
    completeClaudeManualCompactTurn();
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
    completeClaudeManualCompactTurn();
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
    emitClaudeRuntimeSettingsChanged('applied', settings.requestId, settings);
  }
  return applied;
}

function applySettingsCommand(command: UpdateSettingsCommand) {
  const settings: RuntimeSettingsPatch = {
    requestId: command.request_id,
    envName: command.env_name,
    permMode: command.perm_mode,
    permissionScope: command.permission_scope,
    envVars: command.env_vars,
    effort: command.effort,
  };
  const applied = applySettingsToInitCommand(settings);
  if (applied && initCommand?.provider === 'claude') {
    emitClaudeRuntimeSettingsChanged('applied', command.request_id, settings);
  }
  return applied;
}

function emitClaudeRuntimeSettingsChanged(
  state: 'deferred' | 'applied' | 'failed',
  requestId?: string,
  settings?: RuntimeSettingsPatch,
) {
  if (!initCommand || initCommand.provider !== 'claude') {
    return;
  }
  emitEvent({
    type: 'runtime_settings_changed',
    state,
    request_id: requestId ?? null,
    query_generation: claudeQueryGeneration,
    env_name: initCommand.env_name,
    effort: initCommand.effort ?? null,
    perm_mode: initCommand.perm_mode,
    permission_scope: settings?.permissionScope ?? null,
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
    ...(command.permission_scope !== undefined
      ? { permissionScope: command.permission_scope }
      : {}),
    ...(command.env_vars !== undefined ? { envVars: command.env_vars } : {}),
    ...(command.effort !== undefined ? { effort: command.effort } : {}),
    ...(command.force_restart !== undefined ? { forceRestart: command.force_restart } : {}),
  };
  if (initCommand?.provider === 'claude') {
    emitClaudeRuntimeSettingsChanged('deferred', command.request_id, pendingSettings ?? undefined);
  }
}

function isClaudePermissionOnlySettingsCommand(command: UpdateSettingsCommand) {
  return command.perm_mode !== undefined
    && command.env_name === undefined
    && command.env_vars === undefined
    && command.effort === undefined;
}

function isValidSettingsUpdateRequestId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 96
    && /^[A-Za-z0-9_-]+$/.test(value);
}

async function applyClaudePermissionSettingsCommand(command: UpdateSettingsCommand) {
  if (!initCommand || initCommand.provider !== 'claude' || !isClaudePermissionOnlySettingsCommand(command)) {
    return false;
  }

  await applyClaudePermissionModeToQuery(currentClaudeQuery, command.perm_mode!);
  applySettingsCommand(command);
  return true;
}

let runtimeSettingsCommandTail: Promise<void> = Promise.resolve();

async function serializeRuntimeSettingsCommand<T>(operation: () => Promise<T>): Promise<T> {
  const previous = runtimeSettingsCommandTail.catch(() => undefined);
  let release!: () => void;
  runtimeSettingsCommandTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
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
  if (!canRestartClaudeRuntimeForSettings(forceRestart)
    || (hasUnsettledClaudeBackgroundTasks() && !forceRestart)) {
    return false;
  }

  applyPendingSettingsToInitCommand();
  closeClaudeQueryForRecovery(captureCurrentClaudeQuerySnapshot(), {
    interruptBackgroundTasks: forceRestart,
    allowUnsafeClose: forceRestart,
    reason: 'Claude settings changed before the background task settled.',
  });
  return true;
}

function applyClaudeSettingsByRestartingIdleRuntime(command: UpdateSettingsCommand) {
  const forceRestart = command.force_restart === true;
  if (!canRestartClaudeRuntimeForSettings(forceRestart)) {
    return false;
  }

  if (hasUnsettledClaudeBackgroundTasks() && !forceRestart) {
    return false;
  }

  applySettingsCommand(command);
  closeClaudeQueryForRecovery(captureCurrentClaudeQuerySnapshot(), {
    interruptBackgroundTasks: forceRestart,
    allowUnsafeClose: forceRestart,
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
        return waitForClaudeInteractivePromptResponse(
          toolName,
          input,
          options.toolUseID,
          options.agentID,
        );
      }
      if (isClaudePlanExitTool(toolName)) {
        if (backgroundTaskId) {
          return buildDeniedClaudeToolResult(
            options.toolUseID,
            'Background tasks cannot request foreground plan approval.',
          );
        }
        return waitForClaudeInteractivePromptResponse(
          toolName,
          input,
          options.toolUseID,
          options.agentID,
        );
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
    emitClaudeInteractiveResolverExpired(toolUseId, pending);
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
    emitClaudeInteractiveResolverExpired(toolUseId, pending);
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
    emitClaudeInteractiveResolverExpired(toolUseId, pending);
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
  claudeQueryGeneration += 1;
  beginClaudeLifecycleGeneration();

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

      // Capability negotiation is per query generation. Raw lifecycle frames
      // may precede this init and are flushed only after this boundary.
      if (
        message.type === 'system'
        && (message as { subtype?: unknown }).subtype === 'init'
      ) {
        configureClaudeLifecycleFromInit(message);
      }

      if ((message as { type?: unknown }).type === 'command_lifecycle') {
        handleClaudeSdkCommandLifecycle(message);
        continue;
      }

      const sessionId = (message as { session_id?: string } | undefined)?.session_id;
      if (sessionId) {
        emitSessionMeta(sessionId);
      }

      if ((message as { type?: unknown }).type === 'conversation_reset') {
        const reset = message as { new_conversation_id?: unknown };
        emitEvent({
          type: 'lifecycle',
          stage: 'conversation_reset',
          detail: typeof reset.new_conversation_id === 'string'
            ? reset.new_conversation_id
            : 'Claude conversation reset.',
          query_generation: claudeQueryGeneration,
          ...(claudeForegroundPromptUuid
            ? { command_id: claudeForegroundPromptUuid }
            : {}),
        });
        continue;
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
        // Main-chain assistant messages only (subagent output rides parent_tool_use_id)
        // and only the latest one matters: it is the fork cut point for the turn.
        const assistantMessageUuid = (message as { uuid?: unknown }).uuid;
        if (
          typeof assistantMessageUuid === 'string'
          && assistantMessageUuid
          && !claudeMessageParentToolUseId(message)
        ) {
          claudeLastAssistantMessageUuid = assistantMessageUuid;
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
          if (
            !taskNotificationSharesActiveForegroundTurn(originKind)
            && (shouldQuery || !claudeForegroundPromptAccepted)
          ) {
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
        applyPendingClaudeSettingsAfterBackgroundTaskChange();
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
        const stateRecord = message as unknown as Record<string, unknown>;
        const stateCommandId = stateRecord.user_message_uuid ?? stateRecord.command_uuid;
        if (typeof stateCommandId === 'string' && stateCommandId !== claudeForegroundPromptUuid) {
          continue;
        }
        const nonHumanStateIngress = isClaudeBackgroundOwnedMessage(message);
        if (!nonHumanStateIngress && claudeTurnAwaitingResult && claudeForegroundPromptAccepted) {
          claudeLegacyIdleCommandId = message.state === 'idle' ? claudeForegroundPromptUuid : null;
        }
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
            if (
              claudeInterruptRequested
              && claudeLifecycleMode !== 'full'
              && !nonHumanStateIngress
            ) {
              emitClaudeTurnInterrupted();
            }
          }
        }

        claudeLastSessionState = message.state;
        if (
          message.state === 'idle'
          && !nonHumanStateIngress
          && claudeLifecycleMode === 'full'
          && claudeTurnAwaitingResult
          && claudeForegroundPromptUuid
          && !claudeLifecycleTerminalTimer
        ) {
          armClaudeLifecycleTerminalTimer(
            claudeForegroundPromptUuid,
            'missing_terminal_after_idle: lifecycle-capable Claude query became idle without a matching terminal state',
          );
        }
        if (
          message.state === 'idle'
          && claudeTurnAwaitingResult
          && claudeForegroundPromptAccepted
          && claudeDeferredForegroundResult
          && !claudeTurnResultObservation
          && claudePendingNonHumanResultCount === 0
          && !nonHumanStateIngress
        ) {
          const deferredResult = claudeDeferredForegroundResult;
          pendingClaudePromptReplay = null;
          claudeIngressOriginKind = null;
          claudePendingNonHumanResultCount = 0;
          if (claudeLifecycleMode === 'legacy') {
            observeClaudeTurnResult(deferredResult.detail, deferredResult.failed);
          }
        }
        if (
          message.state === 'idle'
          && !nonHumanStateIngress
          && claudeLifecycleMode === 'legacy'
        ) {
          finishClaudeLegacyTurnAfterIdle();
        }
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
        const resultPromptUuid = (message as { user_message_uuid?: unknown }).user_message_uuid;
        const correlatedCommandId = typeof resultPromptUuid === 'string' && resultPromptUuid.trim()
          ? resultPromptUuid.trim()
          : null;
        const resultObservation = claudeResultObservation(message);
        if (
          claudeLifecycleMode === 'full'
          && correlatedCommandId
          && claudeTerminalCommandIds.has(correlatedCommandId)
        ) {
          emitClaudeResultUsage(message);
          observeLateClaudeTurnResult(
            correlatedCommandId,
            resultObservation.detail,
            resultObservation.failed,
          );
          continue;
        }
        if (
          claudeLifecycleMode === 'full'
          && !correlatedCommandId
          && resultOriginKind === 'human'
          && claudeTerminalCommandIds.size > 0
        ) {
          // Once this query has moved past a terminal, an uncorrelated human
          // Result could belong to any earlier command. Never attach it to the
          // current foreground command merely because that command is active.
          continue;
        }
        const priorNonHumanResultKey = claudeNonHumanResultKey(message, resultOriginKind);
        if (priorNonHumanResultKey
          && claudeSeenNonHumanResultKeys.has(priorNonHumanResultKey)) {
          continue;
        }
        const foregroundResult = isForegroundClaudeResult(message);
        if (!foregroundResult) {
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
            if (
              claudeTurnAwaitingResult
              && claudeForegroundPromptAccepted
              && !resultOriginKind
              && typeof resultPromptUuid !== 'string'
            ) {
              const failed = message.subtype !== 'success';
              claudeDeferredForegroundResult = {
                detail: failed
                  ? message.errors?.join('\n') || message.subtype
                  : message.result?.trim() ?? '',
                failed,
              };
            }
          }
          continue;
        }

        claudeIngressOriginKind = null;
        claudePendingNonHumanResultCount = 0;
        pendingClaudePromptReplay = null;
        claudeForegroundPromptAccepted = true;

        emitClaudeResultUsage(message);
        observeClaudeTurnResult(resultObservation.detail, resultObservation.failed);
        finishClaudeLegacyTurnAfterIdle();
        if (!resultObservation.failed) {
          emitClaudeUsageAfterTurn();
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
      && (claudeForegroundCoordinatorStamped || pendingClaudePromptReplay === null)
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
    if (
      initCommand?.provider === 'claude'
      && pendingSettings
      && !claudeInputQueue
      && !currentClaudeQuery
    ) {
      applyPendingSettingsToInitCommand();
      if (!claudeTurnAwaitingResult) {
        emitStatus('ready', 'Settings applied.');
      }
    }
  }

  if (
    claudeLifecycleMode === 'full'
    && claudeInterruptRequested
    && claudeTurnAwaitingResult
    && !stopped
  ) {
    emitClaudeLifecycleProtocolError(
      'missing_interrupt_terminal: lifecycle-capable Claude query ended before a matching terminal state',
    );
  } else if (incompleteResponse) {
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
      if (stopped) {
        return;
      }
      if (claudeInterruptRequested) {
        if (claudeLifecycleMode === 'full') {
          emitClaudeLifecycleProtocolError(
            'missing_interrupt_terminal: lifecycle-capable Claude query ended before a matching terminal state',
          );
          return;
        }
        emitClaudeTurnInterrupted();
        claudeInterruptRequested = false;
        return;
      }
      if (isAbort) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (claudeTurnAwaitingResult && claudeForegroundCoordinatorStamped) {
        emitClaudeDeliveryUncertain(`Claude query failed after command dispatch: ${message}`);
        return;
      }
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
  if (prompt.coordinatorStamped) {
    emitClaudeDeliveryUncertain(
      'Claude query ended before command delivery could be confirmed; automatic replay is disabled.',
    );
    return;
  }
  await ensureClaudePromptQueueReady();
  enqueueClaudePrompt(prompt.text, prompt.images, undefined, prompt.messageUuid);
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
  commandId?: string,
  legacyReplayMessageId?: string,
) {
  if (!claudeInputQueue) {
    throw new Error('Claude streaming input queue is not ready');
  }

  const coordinatorStamped = Boolean(commandId);
  const messageUuid = commandId ?? legacyReplayMessageId ?? randomUUID();
  pendingClaudePromptReplay = {
    text,
    images,
    messageUuid,
    coordinatorStamped,
  };
  claudeInterruptRequested = false;
  claudeInterruptCompletionEmitted = false;
  claudeForegroundPromptUuid = messageUuid;
  claudeAuthoritativeTerminalCommandId = null;
  claudeForegroundCoordinatorStamped = coordinatorStamped;
  claudeForegroundPromptAccepted = false;
  claudeForegroundCommand = /^\/compact(?:\s|$)/iu.test(text.trim())
    ? 'compact'
    : null;
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
  // Helper admission receipt: the prompt reached the SDK input queue and this
  // canonical command id now owns the foreground turn until its terminal.
  emitEvent({
    type: 'lifecycle',
    stage: 'command_admitted',
    detail: messageUuid,
    command_id: messageUuid,
    query_generation: claudeQueryGeneration,
  });
  emitStatus('processing', 'Claude is processing a turn.');
}

function emitClaudeCommandRejected(commandId: string, detail: string) {
  emitEvent({
    type: 'lifecycle',
    stage: 'command_rejected',
    detail,
    command_id: commandId,
    query_generation: claudeQueryGeneration,
  });
}

function rejectClaudeCoordinatorPromptIfBusy(commandId?: string | null) {
  if (
    !commandId
    || !claudeTurnAwaitingResult
    || claudeTurnCompletionEmitted
  ) {
    return false;
  }
  emitClaudeCommandRejected(
    commandId,
    'foreground_busy: a foreground command is already awaiting its terminal',
  );
  return true;
}

function reserveClaudeCoordinatorAdmission(commandId?: string | null) {
  const normalized = commandId?.trim();
  if (!normalized) {
    return true;
  }
  if (rejectClaudeCoordinatorPromptIfBusy(normalized)) {
    return false;
  }
  if (pendingClaudeCoordinatorAdmission) {
    emitClaudeCommandRejected(
      normalized,
      `foreground_busy: command ${pendingClaudeCoordinatorAdmission.commandId} is awaiting helper admission`,
    );
    return false;
  }
  pendingClaudeCoordinatorAdmission = {
    commandId: normalized,
  };
  return true;
}

function cancelPendingClaudeCoordinatorAdmission(commandId: string) {
  if (pendingClaudeCoordinatorAdmission?.commandId !== commandId) {
    return false;
  }
  // Remove the exact reservation immediately. The cancelled command's later
  // consume sees no matching reservation, while a following FIFO command can
  // reserve without waiting for the cancelled command's slow setup await.
  pendingClaudeCoordinatorAdmission = null;
  cancelledClaudeCoordinatorAdmissions.add(commandId);
  return true;
}

function consumeClaudeCoordinatorAdmission(commandId?: string | null) {
  const normalized = commandId?.trim();
  if (!normalized) {
    return true;
  }
  if (pendingClaudeCoordinatorAdmission?.commandId !== normalized) {
    return false;
  }
  pendingClaudeCoordinatorAdmission = null;
  return true;
}

function releaseClaudeCoordinatorAdmission(commandId?: string | null) {
  const normalized = commandId?.trim();
  if (normalized && pendingClaudeCoordinatorAdmission?.commandId === normalized) {
    pendingClaudeCoordinatorAdmission = null;
  }
  if (normalized) {
    cancelledClaudeCoordinatorAdmissions.delete(normalized);
  }
}

function beginClaudeInitialization() {
  claudeInitializationPending = true;
  claudeInitializationError = null;
  claudeInitializationBarrier = new Promise<void>((resolve) => {
    resolveClaudeInitialization = resolve;
  });
}

function settleClaudeInitialization(error?: string) {
  claudeInitializationPending = false;
  claudeInitializationError = error ?? null;
  resolveClaudeInitialization?.();
  resolveClaudeInitialization = null;
}

function emitClaudeInitializationSettled() {
  emitEvent({
    type: 'lifecycle',
    stage: 'initialization_settled',
    detail: 'Claude helper initialization settled and queued input may be admitted.',
    query_generation: claudeQueryGeneration,
  });
}

async function waitForClaudeInitializationForCommand(commandId?: string) {
  await claudeInitializationBarrier;
  const normalized = commandId?.trim();
  if (normalized && cancelledClaudeCoordinatorAdmissions.delete(normalized)) {
    return false;
  }
  if (normalized && initializationRejectedClaudeAdmissions.delete(normalized)) {
    return false;
  }
  if (claudeInitializationError) {
    throw new Error(`Claude initialization failed: ${claudeInitializationError}`);
  }
  return true;
}

function rejectFollowerBeforeInitializationFailure(
  initialCommandId: string | null | undefined,
  detail: string,
) {
  const followerId = pendingClaudeCoordinatorAdmission?.commandId ?? null;
  if (!followerId || followerId === initialCommandId?.trim()) {
    return;
  }
  pendingClaudeCoordinatorAdmission = null;
  initializationRejectedClaudeAdmissions.add(followerId);
  emitClaudeCommandRejected(followerId, `initialization_failed: ${detail}`);
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

async function runCodexTurn(text: string, images: PromptImage[] | null | undefined, abortController: AbortController) {
  const thread = await ensureCodexThread();
  abortController.signal.throwIfAborted();

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
      signal: abortController.signal,
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
  const abortController = new AbortController();
  currentAbortController = abortController;
  emitStatus('processing', 'Codex is processing a turn.');
  try {
    await runCodexTurn(nextPrompt.text, nextPrompt.images, abortController);
    if (!stopped) {
      emitStatus('ready', 'Ready for the next prompt.');
    }
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort && !stopped) {
      emitStatus('ready', 'Turn interrupted. Ready for the next prompt.');
    }
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
    if (currentAbortController === abortController) {
      activeTurn = false;
      currentAbortController = null;
    }
    if (pendingSettings && !stopped) {
      const hadEnvVars = pendingSettings.envVars !== undefined;
      applyPendingSettingsToInitCommand();
      teardownCodexSession(hadEnvVars);
      emitStatus('ready', 'Settings applied.');
    }
    if (stopped) {
      emitStatus('closed_idle', 'Codex runtime stopped.');
      finishClaudeRuntimeTeardown();
    } else {
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

    const waitingForAuthoritativeTerminal = claudeTurnAwaitingResult
      && claudeTurnResultObservation !== null;
    const legacySdkStillSettling = claudeLifecycleMode !== 'full'
      && !claudeTurnAwaitingResult;
    if (
      !claudeInterruptRequested
      && claudeLastSessionState !== null
      && claudeLastSessionState !== 'idle'
      && (waitingForAuthoritativeTerminal || legacySdkStillSettling)
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
    if (command.provider === 'claude') {
      beginClaudeInitialization();
    }
    const initialText = command.initial_prompt?.trim() ?? '';
    const initialImages = command.initial_images?.length ? command.initial_images : null;
    if (
      command.provider === 'claude'
      && (initialText || initialImages)
      && !reserveClaudeCoordinatorAdmission(command.initial_command_id)
    ) {
      return;
    }
    // `init` is a protocol boundary and historically always published its
    // session metadata. Deduplication only applies to repeated SDK frames
    // within that initialized runtime.
    lastEmittedSessionMetaKey = null;
    const forkRequested = command.provider === 'claude'
      && Boolean(command.fork_session)
      && Boolean(command.provider_session_id?.trim());
    const resumedClaudeWithoutTodoSeed = command.provider === 'claude'
      && Boolean(command.provider_session_id?.trim())
      && !command.todo_snapshot_seed;
    todoSnapshotTracker.reset(
      command.todo_snapshot_seed,
      !resumedClaudeWithoutTodoSeed,
    );
    let initProviderSessionId = command.provider_session_id ?? null;
    if (forkRequested) {
      const parentSessionId = command.provider_session_id!.trim();
      try {
        const forked = await forkSession(parentSessionId, {
          upToMessageId: command.fork_at_message_id?.trim() || undefined,
          dir: command.working_dir,
        });
        initProviderSessionId = forked.sessionId;
      } catch (error) {
        const detail = `Failed to fork session: ${error instanceof Error ? error.message : String(error)}`;
        // If exact Stop released the initial owner and Rust already dispatched
        // its FIFO follower, reject that follower before publishing the fatal
        // setup status. Otherwise the backend could retire the helper before
        // observing the follower's definite non-admission.
        rejectFollowerBeforeInitializationFailure(command.initial_command_id, detail);
        settleClaudeInitialization(detail);
        emitEvent({
          type: 'lifecycle',
          stage: 'initialization_failed',
          detail,
          query_generation: claudeQueryGeneration,
        });
        releaseClaudeCoordinatorAdmission(command.initial_command_id);
        if (command.initial_command_id) {
          emitClaudeCommandRejected(command.initial_command_id, detail);
        }
        emitStatus('error', detail);
        return;
      }
    }
    currentProviderSessionId = initProviderSessionId;
    if (command.provider === 'claude') {
      // Followers may construct a query only after resume/fork identity is
      // final. This prevents an exact Stop of a slow initial command from
      // letting the next FIFO prompt start against the parent/null session.
      settleClaudeInitialization();
    }
    browserEvaluateApprovedForSession = false;
    if (currentProviderSessionId) {
      emitSessionMeta(currentProviderSessionId);
      if (command.provider === 'codex') {
        await emitCodexContextUsageFromSessionFile(currentProviderSessionId);
      }
    }
    if (initialText || initialImages) {
      if (command.provider === 'claude') {
        await ensureClaudePromptQueueReady();
        if (stopped) {
          releaseClaudeCoordinatorAdmission(command.initial_command_id);
          return;
        }
        if (!consumeClaudeCoordinatorAdmission(command.initial_command_id)) {
          if (command.initial_command_id
            && cancelledClaudeCoordinatorAdmissions.delete(command.initial_command_id)) {
            emitStatus('ready', 'Native runtime helper initialized; initial prompt was cancelled.');
            emitClaudeInitializationSettled();
          }
          return;
        }
        // No await is allowed between this initialization receipt and the
        // initial admission; a prompt sent immediately after ready must see
        // the initial command as the active foreground owner.
        emitStatus('ready', 'Native runtime helper initialized.');
        emitClaudeInitializationSettled();
        enqueueClaudePrompt(initialText, initialImages, command.initial_command_id ?? undefined);
      } else {
        if (!activeTurn && !stopped) {
          emitStatus('ready', 'Native runtime helper initialized.');
        }
        promptQueue.push({ text: initialText, images: initialImages });
        await runQueuedTurns();
      }
    } else if (command.provider === 'claude') {
      await ensureClaudeSession();
      emitStatus('ready', 'Native runtime helper initialized.');
      emitClaudeInitializationSettled();
    } else if (!activeTurn && !stopped) {
      // Resumed Codex metadata lookup yields to concurrent prompt/interrupt
      // commands. Initialization must not overwrite their execution status.
      emitStatus('ready', 'Native runtime helper initialized.');
    }
    return;
  }

  if (command.type === 'permission_response') {
    const pending = pendingPermissions.get(command.request_id);
    if (pending) {
      pendingPermissions.delete(command.request_id);
      pending.resolve(command.approved);
    } else {
      // A missing resolver must never be a silent success — the desktop owns
      // an attention card that no longer exists in this helper generation.
      emitEvent({
        type: 'permission_responded',
        request_id: command.request_id,
        approved: false,
        responder: 'resolver_expired',
      });
      emitEvent({
        type: 'lifecycle',
        stage: 'permission_response_stale',
        detail: command.request_id,
      });
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
      // A missing resolver must never silently succeed: reply with an explicit
      // stale receipt so the desktop can drop the ghost attention card.
      emitEvent({
        type: 'interactive_response_result',
        tool_use_id: command.tool_use_id,
        prompt_type: command.prompt_type ?? null,
        state: 'stale_no_resolver',
        ...interactiveResponseCorrelation(command, claudeQueryGeneration),
      });
      return;
    }

    if (pending.queryGeneration !== claudeQueryGeneration) {
      emitClaudeInteractiveResolverExpired(command.tool_use_id, pending, command);
      pendingClaudeInteractivePrompts.delete(command.tool_use_id);
      pending.resolve({
        behavior: 'deny',
        message: 'Claude query generation changed before the user prompt was answered.',
        toolUseID: command.tool_use_id,
      });
      return;
    }

    if (
      command.expected_query_generation !== undefined
      && command.expected_query_generation !== pending.queryGeneration
    ) {
      emitEvent({
        type: 'interactive_response_result',
        tool_use_id: command.tool_use_id,
        prompt_type: command.prompt_type ?? null,
        state: 'generation_mismatch',
        ...interactiveResponseCorrelation(command, pending.queryGeneration),
      });
      return;
    }

    if (command.prompt_type !== pending.promptType) {
      emitEvent({
        type: 'interactive_response_result',
        tool_use_id: command.tool_use_id,
        prompt_type: command.prompt_type,
        state: 'prompt_type_mismatch',
        ...interactiveResponseCorrelation(command, pending.queryGeneration),
      });
      return;
    }

    pendingClaudeInteractivePrompts.delete(command.tool_use_id);

    if (command.prompt_type !== 'ask_user_question' && command.prompt_type !== 'plan_exit') {
      pending.resolve({
        behavior: 'deny',
        message: 'Unsupported interactive prompt response.',
        toolUseID: command.tool_use_id,
      });
      emitEvent({
        type: 'interactive_response_result',
        tool_use_id: command.tool_use_id,
        prompt_type: command.prompt_type ?? null,
        state: 'rejected',
        ...interactiveResponseCorrelation(command, pending.queryGeneration),
      });
      return;
    }

    if (Object.keys(command.answers).length === 0) {
      pending.resolve({
        behavior: 'deny',
        message: 'User did not answer the question prompt.',
        toolUseID: command.tool_use_id,
      });
      emitEvent({
        type: 'interactive_response_result',
        tool_use_id: command.tool_use_id,
        prompt_type: command.prompt_type,
        state: 'rejected',
        ...interactiveResponseCorrelation(command, pending.queryGeneration),
      });
      return;
    }

    if (command.prompt_type === 'plan_exit') {
      if (!planExitResponseApproves(command.answers)) {
        const feedback = summarizePlanExitFeedback(command.answers);
        emitClaudeToolUseCompleted(command.tool_use_id, feedback, false);
        pending.resolve(buildDeniedClaudeToolResult(command.tool_use_id, feedback));
        emitEvent({
          type: 'interactive_response_result',
          tool_use_id: command.tool_use_id,
          prompt_type: command.prompt_type,
          state: 'applied',
          ...interactiveResponseCorrelation(command, pending.queryGeneration),
        });
        return;
      }

      emitClaudeToolUseCompleted(
        command.tool_use_id,
        summarizePlanExitApproval(command.answers),
        true,
      );
      pending.resolve(buildAllowedClaudeToolResult(pending.input, command.tool_use_id));
      emitEvent({
        type: 'interactive_response_result',
        tool_use_id: command.tool_use_id,
        prompt_type: command.prompt_type,
        state: 'applied',
        ...interactiveResponseCorrelation(command, pending.queryGeneration),
      });
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
    emitEvent({
      type: 'interactive_response_result',
      tool_use_id: command.tool_use_id,
      prompt_type: command.prompt_type,
      state: 'applied',
      ...interactiveResponseCorrelation(command, pending.queryGeneration),
    });
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
    if (command.request_id !== undefined
      && !isValidSettingsUpdateRequestId(command.request_id)) {
      emitEvent({
        type: 'stderr_line',
        line: 'Rejected update_settings command with an invalid request id.',
      });
      return;
    }

    await serializeRuntimeSettingsCommand(async () => {
      if (!initCommand) {
        emitSettingsUpdateResult(
          command.request_id,
          'failed',
          'Native runtime helper is not initialized.',
        );
        return;
      }

      if (command.perm_mode !== undefined) {
        browserEvaluateApprovedForSession = false;
      }

      if (isClaudePermissionOnlySettingsCommand(command)) {
        try {
          if (await applyClaudePermissionSettingsCommand(command)) {
            // The correlated runtime_settings_changed(applied, request_id) ACK
            // has already been emitted by applySettingsCommand. A bare ready
            // here would clobber foreground ownership during a live turn.
            if (!claudeTurnAwaitingResult) {
              emitStatus('ready', 'Settings applied.');
            }
            emitSettingsUpdateResult(command.request_id, 'applied');
            return;
          }
        } catch (error) {
          emitClaudeRuntimeSettingsChanged('failed', command.request_id, {
            permMode: command.perm_mode,
            permissionScope: command.permission_scope,
          });
          emitEvent({
            type: 'stderr_line',
            line: `Claude permission update failed: ${error instanceof Error ? error.message : String(error)}`,
          });
          emitSettingsUpdateResult(
            command.request_id,
            'failed',
            'Provider rejected the settings update.',
          );
          return;
        }
      }

      if (initCommand.provider === 'claude') {
        try {
          if (canApplySettingsImmediately()) {
            applySettingsCommand(command);
            emitStatus('ready', 'Settings applied.');
            emitSettingsUpdateResult(command.request_id, 'applied');
          } else if (applyClaudeSettingsByRestartingIdleRuntime(command)) {
            emitStatus('ready', 'Settings applied.');
            emitSettingsUpdateResult(command.request_id, 'applied');
          } else {
            queuePendingSettings(command);
            const status = claudeTurnAwaitingResult ? 'processing' : 'ready';
            emitStatus(status, 'Settings will apply to the next Claude runtime.');
            emitSettingsUpdateResult(
              command.request_id,
              'deferred',
              'Settings require a later Claude runtime.',
            );
          }
        } catch (error) {
          emitClaudeRuntimeSettingsChanged('failed', command.request_id, {
            permMode: command.perm_mode,
            permissionScope: command.permission_scope,
          });
          emitEvent({
            type: 'stderr_line',
            line: `Claude settings update failed: ${error instanceof Error ? error.message : String(error)}`,
          });
          emitSettingsUpdateResult(
            command.request_id,
            'failed',
            'Provider rejected the settings update.',
          );
          return;
        }
        return;
      }

      if (canApplySettingsImmediately()) {
        applySettingsCommand(command);
        if (initCommand.provider === 'codex') {
          teardownCodexSession(command.env_vars !== undefined || command.effort !== undefined);
        }
        emitStatus('ready', 'Settings applied.');
        emitSettingsUpdateResult(command.request_id, 'applied');
      } else {
        queuePendingSettings(command);
        emitStatus('processing', 'Settings will apply after the current turn.');
        emitSettingsUpdateResult(
          command.request_id,
          'deferred',
          'Settings require the current Codex turn to finish.',
        );
      }
    });
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
      // A coordinator-stamped prompt must never overlap a live foreground
      // turn: reject it explicitly instead of silently queueing it behind the
      // active command (which would clobber the active turn's identity).
      if (!reserveClaudeCoordinatorAdmission(command.command_id)) {
        return;
      }
      if (!await waitForClaudeInitializationForCommand(command.command_id)) {
        return;
      }
      await waitForClaudeInterruptToSettle();
      if (stopped || runtimeTeardownPreparationId) {
        throw new Error('Claude runtime is stopping and cannot accept a new prompt.');
      }
      await ensureClaudePromptQueueReady();
      if (stopped || runtimeTeardownPreparationId) {
        throw new Error('Claude runtime is stopping and cannot accept a new prompt.');
      }
      // Stop may race either await above. Consuming the reservation and the
      // synchronous queue write form one JS turn, so an exact abandon can
      // never be followed by a late unowned enqueue.
      if (!consumeClaudeCoordinatorAdmission(command.command_id)) {
        if (command.command_id) {
          cancelledClaudeCoordinatorAdmissions.delete(command.command_id);
        }
        return;
      }
      enqueueClaudePrompt(command.text.trim(), command.images, command.command_id);
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

      const expectedCommandId = command.type === 'interrupt_turn'
        ? command.expected_command_id?.trim() || null
        : null;
      const pendingAdmissionCommandId = pendingClaudeCoordinatorAdmission?.commandId ?? null;
      const helperOwnedCommandId = claudeForegroundPromptUuid ?? pendingAdmissionCommandId;
      const stopTarget = captureCurrentClaudeQuerySnapshot();
      if (
        !runtimeTeardown
        && expectedCommandId
        && helperOwnedCommandId !== expectedCommandId
      ) {
        const differentForegroundIsActive = Boolean(helperOwnedCommandId)
          || claudeTurnAwaitingResult;
        emitEvent(differentForegroundIsActive
          ? {
            type: 'lifecycle',
            stage: 'interrupt_target_mismatch',
            detail: `interrupt target ${expectedCommandId} does not match helper foreground ${helperOwnedCommandId ?? 'unknown'}`,
            command_id: expectedCommandId,
            query_generation: claudeQueryGeneration,
          }
          : {
            type: 'lifecycle',
            stage: 'command_abandoned',
            detail: 'interrupt target is not active in this helper generation',
            command_id: expectedCommandId,
            query_generation: claudeQueryGeneration,
          });
        stopped = false;
        emitStatus(
          differentForegroundIsActive ? 'processing' : 'ready',
          differentForegroundIsActive
            ? 'A different foreground command is still active.'
            : 'The interrupted command never entered the helper foreground.',
        );
        return;
      }
      if (
        !runtimeTeardown
        && expectedCommandId
        && cancelPendingClaudeCoordinatorAdmission(expectedCommandId)
      ) {
        emitEvent({
          type: 'lifecycle',
          stage: 'command_abandoned',
          detail: 'interrupt cancelled the command before helper admission',
          command_id: expectedCommandId,
          query_generation: claudeQueryGeneration,
        });
        stopped = false;
        const cancelledInitialSetup = claudeInitializationPending
          && initCommand.initial_command_id?.trim() === expectedCommandId;
        emitStatus(
          cancelledInitialSetup ? 'initializing' : 'ready',
          cancelledInitialSetup
            ? 'The initial prompt was cancelled; Claude session setup is still finishing.'
            : 'The pending command was cancelled before it started.',
        );
        return;
      }
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
        if (claudeLifecycleMode === 'full') {
          if (runtimeTeardown) {
            // Process retirement is the terminal fence for a full runtime
            // teardown. Do not synthesize a foreground terminal before the
            // SDK's matching command_lifecycle frame.
            claudeInterruptRequested = false;
            denyPendingPermissions();
            denyPendingClaudeInteractivePrompts(
              'Native runtime session was closed before user responded.',
            );
            browserToolBridge.rejectAll(
              'Native runtime session was closed before the browser tool completed.',
            );
            closeClaudeQueryForRecovery(stopTarget, {
              interruptBackgroundTasks: forceBackgroundTasks,
              allowUnsafeClose: true,
              reason: 'Claude runtime was stopped before the background task settled.',
            });
            emitStatus('closed_idle', 'Claude runtime stopped after interrupting the active turn.');
            finishClaudeRuntimeTeardown();
            return;
          }
          if (claudeTurnAwaitingResult && claudeForegroundPromptUuid) {
            if (!claudeLifecycleTerminalTimer) {
              armClaudeLifecycleTerminalTimer(
                claudeForegroundPromptUuid,
                'missing_interrupt_terminal: lifecycle-capable Claude query did not emit a matching terminal after interrupt',
              );
            }
            emitStatus('processing', 'Waiting for Claude to confirm the interrupted command terminal.');
          }
          return;
        }
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
    if (runtimeTeardown) {
      // Full Stop closes only after the SDK run and its finally have settled.
      // The Desktop manager separately verifies the owned OS execution domain.
      if (!activeTurn) {
        emitStatus('closed_idle', 'Codex runtime stopped.');
        finishClaudeRuntimeTeardown();
      }
    } else {
      stopped = false;
      emitStatus(activeTurn ? 'processing' : 'ready', activeTurn
        ? 'Waiting for interrupted Codex turn to settle.'
        : 'Turn interrupted. Ready for the next prompt.');
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
    if (command.type === 'init') {
      if (command.provider === 'claude' && claudeInitializationPending) {
        settleClaudeInitialization(message);
      }
      releaseClaudeCoordinatorAdmission(command.initial_command_id);
    }
    if (command.type === 'prompt') {
      releaseClaudeCoordinatorAdmission(command.command_id);
    }
    if (
      command.type === 'init'
      && command.provider === 'claude'
      && command.initial_command_id
      && claudeForegroundPromptUuid !== command.initial_command_id
    ) {
      emitClaudeCommandRejected(command.initial_command_id, message);
    }
    if (
      command.type === 'prompt'
      && initCommand?.provider === 'claude'
      && command.command_id
      && claudeForegroundPromptUuid !== command.command_id
    ) {
      emitClaudeCommandRejected(command.command_id, message);
    }
    emitEvent({
      type: 'stderr_line',
      line: message,
    });
    emitStatus('error', message);
  });
});

rl.on('close', () => {
  streamEventCoalescer.flush();
  // Desktop launches the helper as a dedicated Unix process-group leader. Once parent stdin is
  // gone, kill that owned group first: telemetry and SDK cleanup can throw or block on broken I/O.
  if (terminateOwnedProcessGroupOnParentClose()) {
    return;
  }
  if (!stopped) {
    stopped = true;
    emitStatus('stopped', 'Native runtime helper stdin closed.');
  }
  closeClaudeQueryForRecovery();
  teardownCodexSession(false);
  // The host has closed our stdin (app exit or session close).
  // Give the status write and teardown a moment, then exit regardless of
  // remaining handles.
  setTimeout(() => process.exit(0), 250);
});
