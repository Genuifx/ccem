import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

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
      if (stage === 'completed') this.completedAt = this.now();
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

  private emitMetricsIfReady() {
    if (this.metricsEmitted
      || this.startedAt === undefined || this.completedAt === undefined
      || this.outputTokens === undefined) return;
    const elapsedMs = Math.round(this.completedAt - this.startedAt);
    if (elapsedMs <= 0) return;
    this.metricsEmitted = true;
    this.emit({
      type: 'turn_metrics',
      operation_id: this.id,
      provider: this.provider,
      output_tokens: this.outputTokens,
      elapsed_ms: elapsedMs,
    });
  }
}
