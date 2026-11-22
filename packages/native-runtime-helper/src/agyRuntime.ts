import { randomUUID } from 'node:crypto';
import process from 'node:process';
import {
  AgyAcpClient,
  buildAgyProcessEnv,
  formatAgyAuthRequiredError,
  isAgyAuthRequiredError,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpPermissionOption,
  type AcpPermissionRequestParams,
  type AcpPermissionResponse,
  type AcpSessionUpdateParams,
} from './agyAcpClient';
import type { InputOperation } from './inputOperation';
import { normalizeAgyPermissionMode } from './permissionModes';
import { formatPermissionPreview } from './permissionPreview';
import { buildPromptContentParts, type PromptImage } from './promptContent';
import type { TodoSnapshotTracker } from './todoSnapshots';

export type AgyConfigOptionChoice = {
  value: string;
  name?: string;
  description?: string;
};

export type AgyConfigOptionsSnapshot = {
  current_model: string | null;
  current_effort: string | null;
  supports_effort: boolean;
  models: AgyConfigOptionChoice[];
  efforts: AgyConfigOptionChoice[];
};

export type AgyInitConfig = {
  workingDir: string;
  permMode: string;
  agyPath?: string | null;
  envVars?: Record<string, string>;
  model?: string | null;
  effort?: string | null;
};

export type AgyRuntimeCallbacks = {
  emitEvent: (payload: Record<string, unknown>) => void;
  emitSessionMeta: (providerSessionId: string) => void;
  todoSnapshotTracker: TodoSnapshotTracker;
  registerPermission: (requestId: string, resolve: (approved: boolean) => void) => void;
  unregisterPermission: (requestId: string) => void;
  getCurrentProviderSessionId: () => string | null;
  getInitConfig: () => AgyInitConfig | null;
  onConfigOptionsSynced?: (synced: { model?: string | null; effort?: string | null }) => void;
};

type StartedToolState = {
  rawName: string;
  category: 'execution' | 'file_op' | 'search' | 'task_mgmt' | 'unknown';
};

type ActiveAgyPermissionWaiter = {
  requestId: string;
  toolUseId: string;
  cancel: () => void;
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(extractTextFromContent).filter(Boolean).join('');
  }
  const record = readObject(content);
  if (!record) {
    return '';
  }
  if (typeof record.text === 'string') {
    return record.text;
  }
  if (record.content !== undefined) {
    return extractTextFromContent(record.content);
  }
  return '';
}

function summarizeValue(value: unknown): string {
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

export function classifyAgyToolCategory(
  kind: string | undefined,
  name: string | undefined,
): 'execution' | 'file_op' | 'search' | 'task_mgmt' | 'unknown' {
  const normalizedKind = (kind ?? '').toLowerCase();
  const normalizedName = (name ?? '').toLowerCase();

  if (
    normalizedKind === 'execute'
    || normalizedKind === 'terminal'
    || normalizedKind === 'command'
    || /(run_command|bash|shell|exec|terminal|command)/.test(normalizedName)
  ) {
    return 'execution';
  }
  if (
    normalizedKind === 'read'
    || normalizedKind === 'edit'
    || normalizedKind === 'write'
    || normalizedKind === 'delete'
    || normalizedKind === 'move'
    || /(read_file|write_file|edit_file|replace_file|create_file|delete_file|file)/.test(normalizedName)
  ) {
    return 'file_op';
  }
  if (
    normalizedKind === 'search'
    || normalizedKind === 'fetch'
    || /(search|grep|glob|find|web|fetch)/.test(normalizedName)
  ) {
    return 'search';
  }
  if (
    normalizedKind === 'plan'
    || normalizedKind === 'think'
    || /(todo|plan|task)/.test(normalizedName)
  ) {
    return 'task_mgmt';
  }
  return 'unknown';
}

export function buildAgyPromptBlocks(
  text: string,
  images?: PromptImage[] | null,
): AcpContentBlock[] {
  const parts = buildPromptContentParts(text, images);
  const blocks: AcpContentBlock[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      blocks.push({
        type: 'image',
        mimeType: part.image.mediaType,
        data: part.image.base64Data,
      });
    }
  }
  return blocks;
}

export function selectAgyPermissionOutcome(
  approved: boolean,
  options?: AcpPermissionOption[],
): AcpPermissionResponse {
  const list = Array.isArray(options) ? options : [];
  if (list.length === 0) {
    return { outcome: { outcome: 'cancelled' } };
  }

  if (approved) {
    const allowOnce = list.find((option) => option.kind === 'allow_once');
    const allowAlways = list.find((option) => option.kind === 'allow_always');
    const chosen = allowOnce ?? allowAlways ?? list[0]!;
    return {
      outcome: {
        outcome: 'selected',
        optionId: chosen.optionId,
      },
    };
  }

  const rejectOnce = list.find((option) => option.kind === 'reject_once');
  const rejectAlways = list.find((option) => option.kind === 'reject_always');
  const chosen = rejectOnce ?? rejectAlways;
  if (!chosen) {
    return { outcome: { outcome: 'cancelled' } };
  }
  return {
    outcome: {
      outcome: 'selected',
      optionId: chosen.optionId,
    },
  };
}

const AGY_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function resolveSupportedAgyEffort(
  requested: string,
  supportedValues: readonly string[],
): string | null {
  const trimmed = requested.trim();
  if (!trimmed || supportedValues.length === 0) {
    return null;
  }
  if (supportedValues.includes(trimmed)) {
    return trimmed;
  }
  const requestedIndex = AGY_EFFORT_ORDER.indexOf(trimmed as (typeof AGY_EFFORT_ORDER)[number]);
  if (requestedIndex >= 0) {
    for (let i = requestedIndex - 1; i >= 0; i -= 1) {
      const candidate = AGY_EFFORT_ORDER[i]!;
      if (supportedValues.includes(candidate)) {
        return candidate;
      }
    }
    for (let i = requestedIndex + 1; i < AGY_EFFORT_ORDER.length; i += 1) {
      const candidate = AGY_EFFORT_ORDER[i]!;
      if (supportedValues.includes(candidate)) {
        return candidate;
      }
    }
  }
  return supportedValues[0] ?? null;
}

function getConfigOptionId(option: AcpConfigOption): string | undefined {
  return readString(option.configId) ?? readString(option.id);
}

function normalizeConfigOptionChoices(options: AcpConfigOption['options']): AgyConfigOptionChoice[] {
  if (!Array.isArray(options)) {
    return [];
  }
  const choices: AgyConfigOptionChoice[] = [];
  const seen = new Set<string>();
  for (const item of options) {
    const value = readString(item?.value);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const name = readString(item?.name);
    const description = readString(item?.description);
    choices.push({
      value,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    });
  }
  return choices;
}

function isFullConfigOptionsSnapshot(options: AcpConfigOption[]): boolean {
  return options.some(
    (option) =>
      (option.category === 'model' || getConfigOptionId(option) === 'model')
      && Array.isArray(option.options)
      && option.options.length > 0,
  );
}

export class AgyRuntime {
  private client: AgyAcpClient | null = null;
  private sessionId: string | null = null;
  private configOptions: AcpConfigOption[] = [];
  private currentModel: string | null = null;
  private currentEffort: string | null = null;
  private lastConfigOptionsKey: string | null = null;
  private lastContextUsageKey: string | null = null;
  private pendingFallbackTurnUsage: Record<string, unknown> | null = null;
  private activeOperation: InputOperation | null = null;
  private activeDangerouslySkipPermissions = false;
  private readonly startedTools = new Map<string, StartedToolState>();
  private readonly completedTools = new Set<string>();
  private readonly activePermissions = new Map<string, ActiveAgyPermissionWaiter>();
  private turnCancelled = false;

  constructor(private readonly callbacks: AgyRuntimeCallbacks) {}

  get hasLiveSession(): boolean {
    return Boolean(this.client?.isAlive && this.sessionId);
  }

  async ensureSession(): Promise<{ client: AgyAcpClient; sessionId: string }> {
    const config = this.callbacks.getInitConfig();
    if (!config) {
      throw new Error('Native runtime helper not initialized');
    }

    const normalizedPerm = normalizeAgyPermissionMode(config.permMode);

    if (
      this.client?.isAlive
      && this.sessionId
      && this.activeDangerouslySkipPermissions === normalizedPerm.dangerouslySkipPermissions
    ) {
      return { client: this.client, sessionId: this.sessionId };
    }

    if (this.client) {
      await this.teardown();
    }

    const agyPath = config.agyPath?.trim() || 'agy';
    const env = buildAgyProcessEnv(process.env, config.envVars);
    this.activeDangerouslySkipPermissions = normalizedPerm.dangerouslySkipPermissions;
    this.currentModel = readString(config.model) ?? null;
    this.currentEffort = readString(config.effort) ?? null;
    this.lastConfigOptionsKey = null;
    this.lastContextUsageKey = null;

    const client = new AgyAcpClient({
      agyPath,
      cwd: config.workingDir,
      env,
      dangerouslySkipPermissions: normalizedPerm.dangerouslySkipPermissions,
      onSessionUpdate: (params) => this.handleSessionUpdate(params),
      onRequestPermission: (params) => this.handleRequestPermission(params),
      onStderrLine: (line) => {
        this.callbacks.emitEvent({ type: 'stderr_line', line });
      },
      onWarning: (message) => {
        this.callbacks.emitEvent({ type: 'stderr_line', line: message });
      },
      onExit: () => {
        this.cancelPendingPermissions('runtime_exit');
        if (this.client === client) {
          this.client = null;
          this.sessionId = null;
        }
      },
    });
    this.client = client;

    try {
      await client.initialize();
      const resumeSessionId = this.callbacks.getCurrentProviderSessionId()?.trim() || null;
      const sessionResult = resumeSessionId
        ? await client.sessionResumeOrLoad(resumeSessionId, config.workingDir)
        : await client.sessionNew(config.workingDir);

      const resolvedSessionId = sessionResult.sessionId?.trim();
      if (!resolvedSessionId) {
        throw new Error('Antigravity ACP did not return a sessionId.');
      }

      this.sessionId = resolvedSessionId;
      if (Array.isArray(sessionResult.configOptions)) {
        this.applyConfigOptionsUpdate(sessionResult.configOptions);
      }
      this.callbacks.emitSessionMeta(resolvedSessionId);

      await this.applySessionConfig(client, resolvedSessionId, {
        permMode: config.permMode,
        model: config.model ?? undefined,
        effort: config.effort ?? undefined,
      }, { live: false });

      this.emitConfigOptionsSnapshot();

      return { client, sessionId: resolvedSessionId };
    } catch (error) {
      await this.teardown();
      if (isAgyAuthRequiredError(error)) {
        throw new Error(formatAgyAuthRequiredError(error));
      }
      throw error;
    }
  }

  async runTurn(
    text: string,
    images: PromptImage[] | null | undefined,
    abortController: AbortController,
    operation?: InputOperation,
  ): Promise<void> {
    this.turnCancelled = false;
    const { client, sessionId } = await this.ensureSession();
    abortController.signal.throwIfAborted();

    const promptBlocks = buildAgyPromptBlocks(text, images);
    if (promptBlocks.length === 0) {
      return;
    }

    this.activeOperation = operation ?? null;
    this.pendingFallbackTurnUsage = null;
    this.startedTools.clear();
    this.completedTools.clear();

    const onAbort = () => {
      this.turnCancelled = true;
      this.cancelPendingPermissions('turn_interrupted');
      if (this.client === client && client.isAlive) {
        client.sessionCancel(sessionId);
      }
    };
    abortController.signal.addEventListener('abort', onAbort, { once: true });

    operation?.observe('started', 'Antigravity ACP started the turn.');
    operation?.markResponseStart();
    this.callbacks.emitEvent({
      type: 'lifecycle',
      stage: 'turn_started',
      detail: 'Antigravity is thinking…',
    });

    try {
      const result = await client.sessionPrompt(sessionId, promptBlocks);
      const stopReason = readString(result?.stopReason) ?? 'end_turn';
      const usage = readObject(result?.usage) ?? this.pendingFallbackTurnUsage;
      if (usage) {
        this.emitTurnUsagePayload(usage);
      }

      if (stopReason === 'cancelled' || this.turnCancelled || abortController.signal.aborted) {
        operation?.observe('unknown', 'Antigravity turn interrupted.');
        const abortError = new Error('Antigravity turn interrupted.');
        abortError.name = 'AbortError';
        throw abortError;
      }

      operation?.observe('completed', `Antigravity ACP completed the turn (${stopReason}).`);
      this.callbacks.emitEvent({
        type: 'lifecycle',
        stage: 'turn_completed',
        detail: 'Turn completed',
      });
    } catch (error) {
      if (this.turnCancelled || abortController.signal.aborted) {
        const abortError = new Error('Antigravity turn interrupted.');
        abortError.name = 'AbortError';
        throw abortError;
      }
      if (isAgyAuthRequiredError(error)) {
        const authMessage = formatAgyAuthRequiredError(error);
        operation?.observe('failed', authMessage);
        throw new Error(authMessage);
      }
      const message = error instanceof Error ? error.message : String(error);
      operation?.observe('failed', message);
      throw error;
    } finally {
      abortController.signal.removeEventListener('abort', onAbort);
      this.cancelPendingPermissions('turn_settled');
      this.pendingFallbackTurnUsage = null;
      if (this.activeOperation === operation) {
        this.activeOperation = null;
      }
    }
  }

  async applyLiveSettings(patch: {
    permMode?: string;
    model?: string;
    effort?: string;
    envVarsChanged?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    const config = this.callbacks.getInitConfig();
    if (!config) {
      return { ok: true };
    }
    const nextPerm = normalizeAgyPermissionMode(config.permMode);
    const needsRespawn = Boolean(patch.envVarsChanged)
      || (this.client !== null
        && this.activeDangerouslySkipPermissions !== nextPerm.dangerouslySkipPermissions);

    if (needsRespawn) {
      await this.teardown();
      return { ok: true };
    }

    if (!this.client?.isAlive || !this.sessionId) {
      return { ok: true };
    }

    return this.applySessionConfig(this.client, this.sessionId, {
      ...(patch.permMode !== undefined ? { permMode: patch.permMode } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    }, { live: true });
  }

  interruptTurn(): void {
    this.turnCancelled = true;
    this.cancelPendingPermissions('turn_interrupted');
    if (this.client?.isAlive && this.sessionId) {
      this.client.sessionCancel(this.sessionId);
    }
  }

  async teardown(): Promise<void> {
    this.cancelPendingPermissions('runtime_stopped');
    const client = this.client;
    this.client = null;
    this.sessionId = null;
    this.configOptions = [];
    this.currentModel = null;
    this.currentEffort = null;
    this.lastConfigOptionsKey = null;
    this.lastContextUsageKey = null;
    this.pendingFallbackTurnUsage = null;
    this.startedTools.clear();
    this.completedTools.clear();
    if (client) {
      await client.close();
    }
  }

  private async applySessionConfig(
    client: AgyAcpClient,
    sessionId: string,
    patch: { permMode?: string; effort?: string; model?: string },
    options: { live: boolean },
  ): Promise<{ ok: boolean; error?: string }> {
    const hasPermPatch = patch.permMode !== undefined;
    const hasModelPatch = Boolean(patch.model && patch.model.trim());
    const hasEffortPatch = Boolean(patch.effort && patch.effort.trim());

    if (hasPermPatch && patch.permMode !== undefined) {
      const normalized = normalizeAgyPermissionMode(patch.permMode);
      const modeOption = this.findConfigOption('mode', ['mode']);
      let updatedViaConfig = false;
      if (modeOption) {
        const configId = getConfigOptionId(modeOption) ?? 'mode';
        const outcome = await this.trySetConfigOption(client, sessionId, configId, normalized.acpMode);
        updatedViaConfig = outcome.ok;
      }
      if (!updatedViaConfig) {
        try {
          await client.sessionSetMode(sessionId, normalized.acpMode);
        } catch {
          // Gracefully ignore unsupported mode updates without breaking the turn.
        }
      }
    }

    if (hasModelPatch && patch.model) {
      const requestedModel = patch.model.trim();
      const modelOption = this.findConfigOption('model', ['model']);
      const configId = (modelOption ? getConfigOptionId(modelOption) : undefined) ?? 'model';
      const outcome = await this.trySetConfigOption(client, sessionId, configId, requestedModel);
      if (!outcome.ok) {
        const message = outcome.error || `Antigravity rejected model "${requestedModel}".`;
        this.callbacks.emitEvent({ type: 'stderr_line', line: message });
        this.emitConfigOptionsSnapshot(true);
        if (options.live) {
          return { ok: false, error: message };
        }
      }
    }

    if (hasEffortPatch && patch.effort) {
      const requestedEffort = patch.effort.trim();
      const modelOption = this.findConfigOption('model', ['model']);
      const effortOption = this.findConfigOption('thought_level', [
        'thought_level',
        'effort',
        'thinking_level',
      ]);
      const hasFullCatalog = Boolean(modelOption && Array.isArray(modelOption.options) && modelOption.options.length > 0);
      const supportedEfforts = normalizeConfigOptionChoices(effortOption?.options).map((choice) => choice.value);

      if (hasFullCatalog && !effortOption) {
        if (options.live && !hasModelPatch && !hasPermPatch) {
          const message = `Thinking level is not supported for model "${this.currentModel ?? 'current'}".`;
          this.callbacks.emitEvent({ type: 'stderr_line', line: message });
          this.emitConfigOptionsSnapshot(true);
          return { ok: false, error: message };
        }
      } else {
        let targetEffort = requestedEffort;
        if (supportedEfforts.length > 0 && !supportedEfforts.includes(requestedEffort)) {
          if (!options.live || hasModelPatch) {
            const clamped = resolveSupportedAgyEffort(requestedEffort, supportedEfforts);
            if (clamped) {
              targetEffort = clamped;
            }
          }
        }
        const configId = (effortOption ? getConfigOptionId(effortOption) : undefined) ?? 'thought_level';
        const outcome = await this.trySetConfigOption(client, sessionId, configId, targetEffort);
        if (!outcome.ok) {
          const message = outcome.error || `Antigravity rejected thinking level "${targetEffort}".`;
          this.callbacks.emitEvent({ type: 'stderr_line', line: message });
          this.emitConfigOptionsSnapshot(true);
          // Only fail a standalone live effort update when the server actually advertised
          // thought_level choices; preserve graceful degradation on legacy/mixed updates.
          if (options.live && !hasPermPatch && !hasModelPatch && supportedEfforts.length > 0) {
            return { ok: false, error: message };
          }
        }
      }
    }

    this.emitConfigOptionsSnapshot();
    return { ok: true };
  }

  private findConfigOption(category: string, fallbackIds: string[]): AcpConfigOption | undefined {
    const byCategory = this.configOptions.find((option) => option.category === category);
    if (byCategory) {
      return byCategory;
    }
    return this.configOptions.find((option) => {
      const id = getConfigOptionId(option);
      return id ? fallbackIds.includes(id) : false;
    });
  }

  private async trySetConfigOption(
    client: AgyAcpClient,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await client.sessionSetConfigOption(sessionId, configId, value);
      const record = readObject(result);
      if (Array.isArray(record?.configOptions)) {
        this.applyConfigOptionsUpdate(record.configOptions as AcpConfigOption[]);
      } else if (configId === 'model' && value.trim()) {
        this.currentModel = value.trim();
        this.callbacks.onConfigOptionsSynced?.({ model: this.currentModel });
      } else if (
        (configId === 'thought_level' || configId === 'effort' || configId === 'thinking_level')
        && value.trim()
      ) {
        this.currentEffort = value.trim();
        this.callbacks.onConfigOptionsSynced?.({ effort: this.currentEffort });
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      return { ok: false, error: message };
    }
  }

  private applyConfigOptionsUpdate(incoming: AcpConfigOption[]): void {
    if (incoming.length === 0) {
      return;
    }
    if (this.configOptions.length === 0 || isFullConfigOptionsSnapshot(incoming)) {
      this.configOptions = incoming;
    } else {
      const merged = this.configOptions.map((option) => ({ ...option }));
      for (const patch of incoming) {
        const patchId = getConfigOptionId(patch);
        const index = merged.findIndex((existing) => (
          (patch.category && existing.category === patch.category)
          || (patchId && getConfigOptionId(existing) === patchId)
        ));
        if (index >= 0) {
          merged[index] = {
            ...merged[index],
            ...patch,
            options: Array.isArray(patch.options) ? patch.options : merged[index]!.options,
          };
        } else {
          merged.push(patch);
        }
      }
      this.configOptions = merged;
    }
    this.syncCurrentConfigFromOptions(this.configOptions);
  }

  private syncCurrentConfigFromOptions(options: AcpConfigOption[]): void {
    const modelOption = options.find(
      (option) => option.category === 'model' || getConfigOptionId(option) === 'model',
    );
    const effortOption = options.find((option) => {
      const id = getConfigOptionId(option);
      return option.category === 'thought_level'
        || id === 'thought_level'
        || id === 'effort'
        || id === 'thinking_level';
    });

    const synced: { model?: string | null; effort?: string | null } = {};
    const modelValue = readString(modelOption?.currentValue);
    if (modelValue) {
      this.currentModel = modelValue;
      synced.model = modelValue;
    }

    const effortValue = readString(effortOption?.currentValue);
    if (effortValue) {
      this.currentEffort = effortValue;
      synced.effort = effortValue;
    } else if (
      modelOption
      && Array.isArray(modelOption.options)
      && modelOption.options.length > 0
      && !effortOption
    ) {
      // Full ACP config snapshot explicitly omitted thought_level -> model does not support effort.
      this.currentEffort = null;
      synced.effort = null;
    }

    if (synced.model !== undefined || synced.effort !== undefined) {
      this.callbacks.onConfigOptionsSynced?.(synced);
    }
  }

  private buildConfigOptionsSnapshot(): AgyConfigOptionsSnapshot | null {
    if (this.configOptions.length === 0) {
      return null;
    }
    const modelOption = this.findConfigOption('model', ['model']);
    const effortOption = this.findConfigOption('thought_level', [
      'thought_level',
      'effort',
      'thinking_level',
    ]);
    const models = normalizeConfigOptionChoices(modelOption?.options);
    const efforts = normalizeConfigOptionChoices(effortOption?.options);
    const currentModel = readString(modelOption?.currentValue) ?? this.currentModel ?? null;
    const currentEffort = effortOption
      ? (readString(effortOption.currentValue) ?? this.currentEffort ?? null)
      : null;
    const supportsEffort = efforts.length > 0;
    return {
      current_model: currentModel,
      current_effort: supportsEffort ? currentEffort : null,
      supports_effort: supportsEffort,
      models,
      efforts,
    };
  }

  private emitConfigOptionsSnapshot(force = false): void {
    const snapshot = this.buildConfigOptionsSnapshot();
    if (!snapshot) {
      return;
    }
    const key = JSON.stringify(snapshot);
    if (!force && key === this.lastConfigOptionsKey) {
      return;
    }
    this.lastConfigOptionsKey = key;
    this.callbacks.emitEvent({
      type: 'runtime_config_options_updated',
      provider: 'agy',
      ...snapshot,
    });
  }

  private getCurrentModel(): string {
    return this.currentModel
      ?? readString(this.callbacks.getInitConfig()?.model)
      ?? 'agy';
  }

  private handleSessionUpdate(params: AcpSessionUpdateParams): void {
    const update = readObject(params.update);
    if (!update) {
      return;
    }

    const kind = readString(update.sessionUpdate) ?? readString(update.type);
    if (!kind) {
      return;
    }

    if (kind === 'agent_message_chunk') {
      const text = extractTextFromContent(update.content ?? update.text);
      if (text) {
        this.activeOperation?.markOutputDelta(text);
        this.callbacks.emitEvent({
          type: 'assistant_chunk',
          text,
        });
      }
      return;
    }

    if (kind === 'agent_thought_chunk') {
      const text = extractTextFromContent(update.content ?? update.text);
      if (text) {
        this.activeOperation?.markOutputDelta(text);
        this.callbacks.emitEvent({
          type: 'system_message',
          message: text,
        });
      }
      return;
    }

    if (kind === 'tool_call') {
      this.activeOperation?.markFirstResponse();
      this.activeOperation?.markResponseEnd({ extendToNow: true });
      const toolCallId = readString(update.toolCallId) ?? `agy-tool-${Date.now()}`;
      const rawName = readString(update.title)
        ?? readString(update.name)
        ?? readString(update.kind)
        ?? 'tool_call';
      const category = classifyAgyToolCategory(readString(update.kind), rawName);
      const inputSummary = summarizeValue(
        update.rawInput ?? update.input ?? update.title ?? rawName,
      );

      this.startedTools.set(toolCallId, { rawName, category });
      this.callbacks.emitEvent({
        type: 'tool_use_started',
        tool_use_id: toolCallId,
        category: {
          category,
          raw_name: rawName,
        },
        raw_name: rawName,
        input_summary: inputSummary,
        needs_response: false,
      });
      return;
    }

    if (kind === 'tool_call_update') {
      const toolCallId = readString(update.toolCallId) ?? `agy-tool-${Date.now()}`;
      const status = (readString(update.status) ?? '').toLowerCase();
      const existing = this.startedTools.get(toolCallId);
      const rawName = existing?.rawName
        ?? readString(update.title)
        ?? readString(update.name)
        ?? readString(update.kind)
        ?? 'tool_call';

      if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled') {
        if (this.completedTools.has(toolCallId)) {
          return;
        }
        this.completedTools.add(toolCallId);
        const resultText = extractTextFromContent(update.content)
          || summarizeValue(update.rawOutput ?? update.result ?? update.title ?? status);
        this.callbacks.emitEvent({
          type: 'tool_use_completed',
          tool_use_id: toolCallId,
          raw_name: rawName,
          result_summary: resultText,
          success: status === 'completed',
        });
        return;
      }

      if (!existing) {
        this.activeOperation?.markFirstResponse();
        this.activeOperation?.markResponseEnd({ extendToNow: true });
        const category = classifyAgyToolCategory(readString(update.kind), rawName);
        this.startedTools.set(toolCallId, { rawName, category });
        this.callbacks.emitEvent({
          type: 'tool_use_started',
          tool_use_id: toolCallId,
          category: {
            category,
            raw_name: rawName,
          },
          raw_name: rawName,
          input_summary: summarizeValue(update.rawInput ?? update.title ?? rawName),
          needs_response: false,
        });
      } else {
        const progressText = extractTextFromContent(update.content) || readString(update.title);
        if (progressText) {
          this.callbacks.emitEvent({
            type: 'lifecycle',
            stage: 'tool_progress',
            detail: `${rawName}: ${progressText}`,
          });
        }
      }
      return;
    }

    if (kind === 'plan') {
      const entries = update.entries ?? update.plan ?? update.items;
      const snapshot = this.callbacks.todoSnapshotTracker.fromAgyPlan(entries);
      if (snapshot) {
        this.callbacks.emitEvent({
          type: 'tool_use_started',
          tool_use_id: `agy-plan-${snapshot.revision}`,
          category: {
            category: 'task_mgmt',
            raw_name: 'plan',
          },
          raw_name: 'plan',
          input_summary: JSON.stringify({
            type: 'plan',
            items: snapshot.items,
          }),
          needs_response: false,
          todo_snapshot: snapshot,
        });
      }
      return;
    }

    if (kind === 'usage_update') {
      this.activeOperation?.markResponseEnd({ extendToNow: true });
      this.handleUsageUpdate(update);
      return;
    }

    if (kind === 'config_option_update') {
      if (Array.isArray(update.configOptions)) {
        this.applyConfigOptionsUpdate(update.configOptions as AcpConfigOption[]);
        this.emitConfigOptionsSnapshot();
      }
      return;
    }
  }

  private handleUsageUpdate(update: Record<string, unknown>): void {
    const used = readFiniteNumber(update.used);
    const size = readFiniteNumber(update.size)
      ?? readFiniteNumber(update.contextWindowSize)
      ?? readFiniteNumber(update.context_window_size);

    if (used !== undefined && used >= 0 && size !== undefined && size > 0) {
      const usedTokens = Math.trunc(used);
      const maxTokens = Math.trunc(size);
      const model = this.getCurrentModel();
      const key = `${usedTokens}:${maxTokens}:${model}`;
      if (key !== this.lastContextUsageKey) {
        this.lastContextUsageKey = key;
        this.callbacks.emitEvent({
          type: 'context_usage',
          provider: 'agy',
          used_tokens: usedTokens,
          max_tokens: maxTokens,
          raw_max_tokens: maxTokens,
          percentage: (usedTokens / maxTokens) * 100,
          auto_compact_threshold: null,
          is_auto_compact_enabled: true,
          model,
          categories: [],
        });
      }
      return;
    }

    // Fallback for non-standard ACP servers that report per-turn token counts
    // in usage_update instead of session/prompt result.usage. Never treat `used`
    // (context window occupancy) as turn input tokens.
    const usageRecord = readObject(update.usage) ?? update;
    const hasExplicitTurnUsage =
      readFiniteNumber(usageRecord.inputTokens) !== undefined
      || readFiniteNumber(usageRecord.input_tokens) !== undefined
      || readFiniteNumber(usageRecord.outputTokens) !== undefined
      || readFiniteNumber(usageRecord.output_tokens) !== undefined;
    if (hasExplicitTurnUsage) {
      this.pendingFallbackTurnUsage = update;
    }
  }

  private emitTurnUsagePayload(record: Record<string, unknown>): void {
    const usageRecord = readObject(record.usage) ?? record;
    const inputTokens = readFiniteNumber(usageRecord.inputTokens)
      ?? readFiniteNumber(usageRecord.input_tokens)
      ?? 0;
    const outputTokens = readFiniteNumber(usageRecord.outputTokens)
      ?? readFiniteNumber(usageRecord.output_tokens)
      ?? 0;
    const cacheReadTokens = readFiniteNumber(usageRecord.cachedReadTokens)
      ?? readFiniteNumber(usageRecord.cacheReadTokens)
      ?? readFiniteNumber(usageRecord.cache_read_tokens)
      ?? 0;
    const cacheCreationTokens = readFiniteNumber(usageRecord.cachedWriteTokens)
      ?? readFiniteNumber(usageRecord.cacheCreationTokens)
      ?? readFiniteNumber(usageRecord.cache_creation_tokens)
      ?? 0;
    const costRecord = readObject(record.cost) ?? readObject(usageRecord.cost);
    const totalCostUsd = readFiniteNumber(costRecord?.amount)
      ?? readFiniteNumber(usageRecord.totalCostUsd)
      ?? readFiniteNumber(usageRecord.total_cost_usd)
      ?? null;

    if (outputTokens > 0) {
      this.activeOperation?.recordOutputTokens(Math.trunc(outputTokens));
    }

    this.callbacks.emitEvent({
      type: 'token_usage',
      provider: 'agy',
      ...(this.activeOperation ? { operation_id: this.activeOperation.id } : {}),
      input_tokens: Math.trunc(inputTokens),
      output_tokens: Math.trunc(outputTokens),
      cache_read_tokens: Math.trunc(cacheReadTokens),
      cache_creation_tokens: Math.trunc(cacheCreationTokens),
      ...(totalCostUsd !== null ? { total_cost_usd: totalCostUsd } : {}),
      scope: 'turn_total',
    });
  }

  private async handleRequestPermission(
    params: AcpPermissionRequestParams,
  ): Promise<AcpPermissionResponse> {
    const toolCall = readObject(params.toolCall);
    const toolUseId = readString(toolCall?.toolCallId) ?? `agy-perm-${randomUUID()}`;
    const rawName = readString(toolCall?.title)
      ?? readString(toolCall?.kind)
      ?? 'Antigravity tool';
    const rawSummary = summarizeValue(toolCall?.rawInput ?? toolCall?.title ?? rawName);
    const requestId = randomUUID();
    const options = Array.isArray(params.options) ? params.options : [];

    if (!this.startedTools.has(toolUseId)) {
      const category = classifyAgyToolCategory(readString(toolCall?.kind), rawName);
      this.startedTools.set(toolUseId, { rawName, category });
      this.callbacks.emitEvent({
        type: 'tool_use_started',
        tool_use_id: toolUseId,
        category: {
          category,
          raw_name: rawName,
        },
        raw_name: rawName,
        input_summary: formatPermissionPreview(rawSummary, 160),
        needs_response: false,
      });
    }

    this.callbacks.emitEvent({
      type: 'permission_required',
      request_id: requestId,
      tool_use_id: toolUseId,
      tool_name: formatPermissionPreview(rawName, 80),
      input_summary: formatPermissionPreview(rawSummary, 160),
    });

    return new Promise<AcpPermissionResponse>((resolve) => {
      let settled = false;

      const finish = (response: AcpPermissionResponse, approved: boolean, responder: string) => {
        if (settled) {
          return;
        }
        settled = true;
        this.activePermissions.delete(requestId);
        this.callbacks.unregisterPermission(requestId);
        this.callbacks.emitEvent({
          type: 'permission_responded',
          request_id: requestId,
          tool_use_id: toolUseId,
          approved,
          responder,
        });
        resolve(response);
      };

      this.activePermissions.set(requestId, {
        requestId,
        toolUseId,
        cancel: () => {
          finish({ outcome: { outcome: 'cancelled' } }, false, 'cancelled');
        },
      });

      this.callbacks.registerPermission(requestId, (approved) => {
        finish(selectAgyPermissionOutcome(approved, options), approved, 'desktop');
      });
    });
  }

  private cancelPendingPermissions(_reason: string): void {
    const pending = Array.from(this.activePermissions.values());
    for (const waiter of pending) {
      waiter.cancel();
    }
  }
}
