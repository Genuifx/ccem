import type {
  LoginBrowserRecentActivity,
  LoginBrowserRecentArtifactKind,
} from '@/lib/tauri-ipc';

export interface SavedProfileRecentProofSummary {
  total: number;
  latestModifiedAt: string | null;
  kinds: LoginBrowserRecentArtifactKind[];
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
