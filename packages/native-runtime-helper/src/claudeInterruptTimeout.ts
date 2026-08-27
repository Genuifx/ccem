export const DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS = 8_000;

export function resolveClaudeInterruptTimeoutMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') {
    return DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS;
  }
  return Math.min(DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS, Math.max(0, parsed));
}
