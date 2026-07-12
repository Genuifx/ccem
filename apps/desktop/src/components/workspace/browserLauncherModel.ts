import type {
  BrowserRuntimeReadiness,
  LoginBrowserRecentActivity,
  LoginBrowserRecentArtifactKind,
} from '@/lib/tauri-ipc';

export type BrowserRuntimeActionMode =
  | 'resume'
  | 'active'
  | 'failed'
  | 'ready'
  | 'prepare';

export interface BrowserRuntimePresentation {
  canOpenProfiles: boolean;
  showOperation: boolean;
  showFailure: boolean;
  actionMode: BrowserRuntimeActionMode;
}

export interface SavedProfileRecentProofSummary {
  total: number;
  latestModifiedAt: string | null;
  kinds: LoginBrowserRecentArtifactKind[];
}

export function deriveBrowserRuntimePresentation(
  runtime: BrowserRuntimeReadiness,
): BrowserRuntimePresentation {
  const showOperation = runtime.phase !== 'idle';
  const showFailure = runtime.error !== null;
  const actionMode: BrowserRuntimeActionMode = runtime.phase === 'paused'
    ? 'resume'
    : showOperation
      ? 'active'
      : showFailure
        ? 'failed'
        : runtime.status === 'ready'
          ? 'ready'
          : 'prepare';

  return {
    canOpenProfiles: runtime.status === 'ready' && runtime.active !== null,
    showOperation,
    showFailure,
    actionMode,
  };
}

export function summarizeSavedProfileRecentProof(
  activity: LoginBrowserRecentActivity,
): SavedProfileRecentProofSummary {
  let latestModifiedAt: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  const kinds = new Set<LoginBrowserRecentArtifactKind>();
  for (const artifact of activity.artifacts) {
    kinds.add(artifact.kind);
    const timestamp = Date.parse(artifact.modified_at);
    if (Number.isFinite(timestamp) && timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
      latestModifiedAt = artifact.modified_at;
    }
  }
  return {
    total: activity.artifacts.length,
    latestModifiedAt,
    kinds: [...kinds].sort(),
  };
}
