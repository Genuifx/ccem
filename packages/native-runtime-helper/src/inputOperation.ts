import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const PROGRESS_INTERVAL_MS = 500;

/** Rough live estimate only (≈4 ASCII chars or 0.7 token per CJK char); each
 * response snaps to its real usage as soon as the provider reports it. */
function estimateTokens(text: string) {
  let tokens = 0;
  for (const char of text) tokens += char.charCodeAt(0) < 128 ? 0.25 : 0.7;
  return tokens;
}

/** Responses smaller than this say too little about the tokenizer. */
const MIN_CALIBRATION_ESTIMATE = 50;
/** usage ÷ raw estimate of the latest settled response. One helper process
 * serves one session (one model), so later turns inherit its tokenizer. */
let estimateScale = 1;

export type InputOperationStage = 'started' | 'completed' | 'failed' | 'unknown';

/** One actual helper invocation. External IDs are correlation, not deduplication. */
export class InputOperation {
  readonly id = randomUUID();
  readonly clientMessageIds: string[];
  private started = false;
  private terminal = false;
  private startedAt: number | undefined;
  private completedAt: number | undefined;
  private outputTokens: number | undefined;
  private metricsEmitted = false;
  /** Sum of first→last streamed delta per model response: excludes time to
   * first token, tool execution and waiting between responses. */
  private generationMs = 0;
  private responseFirstDeltaAt: number | undefined;
  private responseLastDeltaAt: number | undefined;
  /** Live progress: finished responses use their authoritative usage; the
   * response in flight is estimated from streamed text until its usage lands. */
  private settledOutputTokens = 0;
  private responseUsageTokens: number | undefined;
  private responseEstimateTokens = 0;
  private lastProgressAt: number | undefined;

  constructor(
    private readonly provider: 'claude' | 'codex',
    clientMessageIds: unknown,
    private readonly emit: (payload: Record<string, unknown>) => void,
    private readonly commandId?: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.clientMessageIds = Array.isArray(clientMessageIds)
      ? [...new Set(clientMessageIds.filter((id): id is string =>
        typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))]
      : [];
  }

  observe(stage: InputOperationStage, detail: string, providerTurnId?: string) {
    if (this.terminal || (stage === 'started' && this.started)) return;
    if (stage === 'started') {
      this.started = true;
      this.startedAt = this.now();
    } else {
      this.terminal = true;
      if (stage === 'completed') {
        this.completedAt = this.now();
        this.closeResponse();
      }
    }
    // Initial/legacy inputs have no external IDs. They still own an execution;
    // an empty list never borrows the preceding user's correlation identity.
    this.emit({
      type: 'input_operation',
      operation_id: this.id,
      client_message_ids: this.clientMessageIds,
      provider: this.provider,
      stage,
      detail,
      ...(this.commandId ? { command_id: this.commandId } : {}),
      ...(providerTurnId ? { provider_turn_id: providerTurnId } : {}),
    });
    this.emitMetricsIfReady();
  }

  /** Only authoritative, successful, current-turn output counts belong here.
   * Usage may arrive after the terminal; never include that transport delay. */
  recordOutputTokens(tokens: unknown) {
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) return;
    if (this.outputTokens !== undefined) return;
    this.outputTokens = tokens;
    this.emitMetricsIfReady();
  }

  /** A new main-agent model response began streaming. */
  markResponseStart() {
    if (!this.started || this.terminal) return;
    this.closeResponse();
  }

  /** A main-agent output delta (text, thinking or tool input) arrived. */
  markOutputDelta(text?: string) {
    if (!this.started || this.terminal) return;
    const at = this.now();
    this.responseFirstDeltaAt ??= at;
    this.responseLastDeltaAt = at;
    if (text) this.responseEstimateTokens += estimateTokens(text);
    this.emitProgress(false);
  }

  /** The in-flight response's authoritative output usage (message_delta). */
  recordResponseOutputTokens(tokens: unknown) {
    if (!this.started || this.terminal) return;
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) return;
    this.responseUsageTokens = tokens;
    this.emitProgress(true);
  }

  private closeResponse() {
    if (this.responseFirstDeltaAt !== undefined && this.responseLastDeltaAt !== undefined) {
      this.generationMs += this.responseLastDeltaAt - this.responseFirstDeltaAt;
    }
    if (this.responseUsageTokens !== undefined && this.responseEstimateTokens >= MIN_CALIBRATION_ESTIMATE) {
      estimateScale = Math.min(3, Math.max(0.3, this.responseUsageTokens / this.responseEstimateTokens));
    }
    this.settledOutputTokens += this.liveResponseTokens();
    this.responseFirstDeltaAt = undefined;
    this.responseLastDeltaAt = undefined;
    this.responseUsageTokens = undefined;
    this.responseEstimateTokens = 0;
  }

  private liveResponseTokens() {
    return this.responseUsageTokens ?? Math.round(this.responseEstimateTokens * estimateScale);
  }

  /** Throttled live counter for the running turn; the final turn_metrics wins. */
  private emitProgress(force: boolean) {
    const at = this.now();
    if (!force && this.lastProgressAt !== undefined
      && at - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = at;
    const span = this.responseFirstDeltaAt !== undefined && this.responseLastDeltaAt !== undefined
      ? this.responseLastDeltaAt - this.responseFirstDeltaAt : 0;
    const generationMs = Math.round(this.generationMs + span);
    this.emit({
      type: 'turn_progress',
      operation_id: this.id,
      provider: this.provider,
      output_tokens: this.settledOutputTokens + this.liveResponseTokens(),
      ...(generationMs > 0 ? { generation_ms: generationMs } : {}),
    });
  }

  private emitMetricsIfReady() {
    if (this.metricsEmitted
      || this.startedAt === undefined || this.completedAt === undefined
      || this.outputTokens === undefined) return;
    const elapsedMs = Math.round(this.completedAt - this.startedAt);
    if (elapsedMs <= 0) return;
    this.metricsEmitted = true;
    const generationMs = Math.round(this.generationMs);
    this.emit({
      type: 'turn_metrics',
      operation_id: this.id,
      provider: this.provider,
      output_tokens: this.outputTokens,
      elapsed_ms: elapsedMs,
      ...(generationMs > 0 ? { generation_ms: generationMs } : {}),
    });
  }
}
