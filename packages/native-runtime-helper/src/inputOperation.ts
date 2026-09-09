import { randomUUID } from 'node:crypto';

export type InputOperationStage = 'started' | 'completed' | 'failed' | 'unknown';

/** One actual helper invocation. External IDs are correlation, not deduplication. */
export class InputOperation {
  readonly id = randomUUID();
  readonly clientMessageIds: string[];
  private started = false;
  private terminal = false;

  constructor(
    private readonly provider: 'claude' | 'codex',
    clientMessageIds: unknown,
    private readonly emit: (payload: Record<string, unknown>) => void,
    private readonly commandId?: string,
  ) {
    this.clientMessageIds = Array.isArray(clientMessageIds)
      ? [...new Set(clientMessageIds.filter((id): id is string =>
        typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))]
      : [];
  }

  observe(stage: InputOperationStage, detail: string, providerTurnId?: string) {
    if (this.terminal || (stage === 'started' && this.started)) return;
    if (stage === 'started') this.started = true;
    else this.terminal = true;
    // An uncorrelated legacy command never borrows the last user's identity.
    if (!this.clientMessageIds.length) return;
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
  }
}
