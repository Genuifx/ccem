import {
  buildCcemSessionLink,
  type CcemSessionLinkFocus,
} from '@/components/workspace/sessionLinks';

export interface CronRunSessionTarget {
  id: string;
  runtimeId?: string | null;
  providerSessionId?: string | null;
  workingDir?: string | null;
  status?: string | null;
}

export interface CronRunSessionAvailability {
  canOpen: boolean;
  reason: 'live' | 'history' | 'unavailable';
  link: string | null;
}

function normalizeOptional(value?: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

/**
 * Build a Workspace deep-link for a cron run.
 * Preference: live runtime first, then provider history session.
 * focus defaults to live so Workspace prefers restorable live sessions and falls back to history.
 */
export function buildCronRunSessionLink(
  run: CronRunSessionTarget,
  options?: { focus?: CcemSessionLinkFocus | null },
): string | null {
  const runtimeId = normalizeOptional(run.runtimeId);
  const providerSessionId = normalizeOptional(run.providerSessionId);
  const cwd = normalizeOptional(run.workingDir);
  const focus = options?.focus ?? 'live';

  if (runtimeId) {
    return buildCcemSessionLink({
      source: 'claude',
      idKind: 'runtime',
      id: runtimeId,
      runtimeId,
      providerSessionId,
      cwd,
      focus,
    });
  }

  if (providerSessionId) {
    return buildCcemSessionLink({
      source: 'claude',
      idKind: 'provider',
      id: providerSessionId,
      runtimeId: null,
      providerSessionId,
      cwd,
      focus,
    });
  }

  return null;
}

export function getCronRunSessionAvailability(
  run: CronRunSessionTarget,
): CronRunSessionAvailability {
  const runtimeId = normalizeOptional(run.runtimeId);
  const link = buildCronRunSessionLink(run, { focus: 'live' });
  if (!link) {
    return { canOpen: false, reason: 'unavailable', link: null };
  }
  if (runtimeId || run.status === 'running') {
    return { canOpen: true, reason: 'live', link };
  }
  return { canOpen: true, reason: 'history', link };
}
