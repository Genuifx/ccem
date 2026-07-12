import type {
  LoginBrowserControlOwner,
  LoginBrowserRecentActivity,
  LoginBrowserRecentArtifact,
  LoginBrowserRecentArtifactKind,
  LoginBrowserSessionSnapshot,
} from '@/lib/tauri-ipc';

export const LOGIN_BROWSER_RECENT_ARTIFACT_KINDS: readonly LoginBrowserRecentArtifactKind[] = [
  'screenshot',
  'interaction_snapshot',
  'console_log',
  'network_log',
  'audit_log',
];

export type LoginBrowserControlAction =
  | 'handoff'
  | 'pause'
  | 'takeover'
  | 'close'
  | 'force_close';

export type LoginBrowserOwnerTone = 'human' | 'agent' | 'paused' | 'danger';

export interface LoginBrowserControlModel {
  owner: LoginBrowserControlOwner;
  ownerTone: LoginBrowserOwnerTone;
  primaryAction: LoginBrowserControlAction | null;
  secondaryAction: LoginBrowserControlAction | null;
  closeAction: Extract<LoginBrowserControlAction, 'close' | 'force_close'> | null;
  canControl: boolean;
}

export interface LoginBrowserRecentProofSummary {
  total: number;
  counts: Record<LoginBrowserRecentArtifactKind, number>;
  latest: LoginBrowserRecentArtifact | null;
}

export function deriveLoginBrowserControlModel(
  snapshot: LoginBrowserSessionSnapshot,
): LoginBrowserControlModel {
  if (snapshot.status === 'cleanup_required') {
    return {
      owner: 'paused',
      ownerTone: 'danger',
      primaryAction: null,
      secondaryAction: null,
      closeAction: 'force_close',
      canControl: false,
    };
  }

  if (snapshot.status !== 'running') {
    return {
      owner: 'paused',
      ownerTone: 'paused',
      primaryAction: null,
      secondaryAction: null,
      closeAction: null,
      canControl: false,
    };
  }

  switch (snapshot.control) {
    case 'agent':
      return {
        owner: 'agent',
        ownerTone: 'agent',
        primaryAction: 'pause',
        secondaryAction: 'takeover',
        closeAction: 'close',
        canControl: true,
      };
    case 'paused':
      return {
        owner: 'paused',
        ownerTone: 'paused',
        primaryAction: 'handoff',
        secondaryAction: 'takeover',
        closeAction: 'close',
        canControl: true,
      };
    case 'user':
    default:
      return {
        owner: 'user',
        ownerTone: 'human',
        primaryAction: 'handoff',
        secondaryAction: null,
        closeAction: 'close',
        canControl: true,
      };
  }
}

export function compactOpaqueId(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 14)}…${value.slice(14, 18)}·${value.slice(-8)}`;
}

export function summarizeLoginBrowserRecentActivity(
  activity: LoginBrowserRecentActivity,
): LoginBrowserRecentProofSummary {
  const counts: Record<LoginBrowserRecentArtifactKind, number> = {
    screenshot: 0,
    interaction_snapshot: 0,
    console_log: 0,
    network_log: 0,
    audit_log: 0,
  };
  let latest: LoginBrowserRecentArtifact | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;

  for (const artifact of activity.artifacts) {
    counts[artifact.kind] += 1;
    const artifactTime = Date.parse(artifact.modified_at);
    if (latest === null || (Number.isFinite(artifactTime) && artifactTime > latestTime)) {
      latest = artifact;
      latestTime = artifactTime;
    }
  }

  return { total: activity.artifacts.length, counts, latest };
}

export function formatLoginBrowserArtifactBytes(byteSize: number): string {
  const safeBytes = Number.isFinite(byteSize) ? Math.max(0, byteSize) : 0;
  if (safeBytes < 1024) return `${Math.round(safeBytes)} B`;
  if (safeBytes < 1024 * 1024) {
    return `${Number((safeBytes / 1024).toFixed(1))} KB`;
  }
  return `${Number((safeBytes / (1024 * 1024)).toFixed(1))} MB`;
}

export function formatLoginBrowserControlError(error: unknown): string {
  if (error === null || error === undefined) {
    return 'Login Browser control is unavailable.';
  }
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, ' ').trim().slice(0, 160)
    || 'Login Browser control is unavailable.';
}
