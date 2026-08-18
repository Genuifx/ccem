import type { RouterConfig, RouterLaunchDraft } from '@ccem/core/browser';
import { DEFAULT_ONLY_PROFILE_ID, MY_DEFAULT_ROUTER_PROFILE_ID } from '@/lib/routerProfiles';
import type { WorkspaceComposerProvider } from './composerCapabilities';

export { DEFAULT_ONLY_PROFILE_ID, MY_DEFAULT_ROUTER_PROFILE_ID };

/**
 * Per-Composer Dynamic Routing opt-in draft (frontend-only state).
 *
 * New Composers start opted out. A history Composer can instead reference an
 * authoritative routed runtime; Rust clones its private route/auth record and
 * mints fresh secrets when the user continues that conversation.
 */
export interface ComposerRouteDraft {
  optIn: boolean;
  /** Selected named profile; null = "my defaults" (current config at submit). */
  profileId: string | null;
  /** History-only reference. Never contains bindings, allowed envs, auth data, or secrets. */
  restoredSource?: {
    runtimeId: string;
    sourceProfileId: string | null;
    profileRevision: number | null;
    /** True only when the effective route can reach no env but defaultEnv. */
    isDefaultOnly: boolean;
  };
}

export type RouterLaunchDraftResolution =
  | { ok: true; value: RouterLaunchDraft }
  | {
      ok: false;
      code: 'NOT_OPTED_IN' | 'PROFILE_MISSING' | 'CONFIG_UNAVAILABLE' | 'HISTORY_RUNTIME_REQUIRED';
    };

export type ComposerRouteDraftLabel =
  | { kind: 'myDefault' }
  | { kind: 'defaultOnly' }
  | { kind: 'profile'; profileName: string }
  | { kind: 'missingProfile' }
  | { kind: 'custom' };

export type HistoryRouteResolutionStatus = 'idle' | 'resolving' | 'ready' | 'failed';

/** Claude history must not submit until its authoritative route state is known. */
export function isHistoryRouteContinuationBlocked(
  provider: WorkspaceComposerProvider | 'opencode',
  status: HistoryRouteResolutionStatus,
): boolean {
  return provider === 'claude' && status !== 'ready';
}

export function createComposerRouteDraft(): ComposerRouteDraft {
  return { optIn: false, profileId: null };
}

/** Off is a full reset: re-enabling starts from the current my-defaults config. */
export function toggleComposerRouteDraft(optIn: boolean): ComposerRouteDraft {
  return optIn ? { optIn: true, profileId: null } : createComposerRouteDraft();
}

export function resetComposerRouteDraft(): ComposerRouteDraft {
  return createComposerRouteDraft();
}

/** Explicit user selection always leaves a restored history snapshot. */
export function selectRouteDraftSource(
  _draft: ComposerRouteDraft,
  profileId: string | null,
): ComposerRouteDraft {
  return { optIn: true, profileId };
}

/** Plus-menu "动态路由" is offered only for routing-capable providers. */
export function isRouteDraftRowVisible(provider: WorkspaceComposerProvider | 'opencode'): boolean {
  return provider === 'claude';
}

export function isRouteDraftPillVisible(
  draft: ComposerRouteDraft | null | undefined,
  provider: WorkspaceComposerProvider,
): boolean {
  return Boolean(draft?.optIn) && isRouteDraftRowVisible(provider);
}

/** Resolve a new opt-in against the current RouterConfig at submit time. */
export function resolveRouterLaunchDraft(
  draft: ComposerRouteDraft,
  routerConfig: RouterConfig | null,
): RouterLaunchDraftResolution {
  if (!draft.optIn) return { ok: false, code: 'NOT_OPTED_IN' };
  if (draft.restoredSource) return { ok: false, code: 'HISTORY_RUNTIME_REQUIRED' };
  if (!routerConfig) return { ok: false, code: 'CONFIG_UNAVAILABLE' };

  if (draft.profileId === null) {
    return {
      ok: true,
      value: {
        bindings: { ...routerConfig.bindings } as Record<string, string>,
        allowedEnvs: [...routerConfig.defaultAllowedEnvs],
        sourceProfileId: MY_DEFAULT_ROUTER_PROFILE_ID,
        profileRevision: null,
        dynamicRouting: routerConfig.dynamicRouting,
      },
    };
  }

  if (draft.profileId === DEFAULT_ONLY_PROFILE_ID) {
    return {
      ok: true,
      value: {
        bindings: {},
        allowedEnvs: [],
        sourceProfileId: null,
        profileRevision: null,
        dynamicRouting: routerConfig.dynamicRouting,
      },
    };
  }

  const profile = routerConfig.profiles.find((candidate) => candidate.id === draft.profileId);
  if (!profile) return { ok: false, code: 'PROFILE_MISSING' };
  return {
    ok: true,
    value: {
      bindings: { ...profile.bindings } as Record<string, string>,
      allowedEnvs: [...profile.allowedEnvs],
      sourceProfileId: profile.id,
      profileRevision: profile.revision,
      dynamicRouting: routerConfig.dynamicRouting,
    },
  };
}

export function resolveRouteDraftLabel(
  draft: ComposerRouteDraft,
  routerConfig: RouterConfig | null,
): ComposerRouteDraftLabel {
  if (draft.restoredSource) {
    const source = draft.restoredSource;
    if (source.sourceProfileId === DEFAULT_ONLY_PROFILE_ID) {
      return { kind: 'defaultOnly' };
    }
    if (source.sourceProfileId === null) {
      return source.isDefaultOnly ? { kind: 'defaultOnly' } : { kind: 'custom' };
    }
    if (source.sourceProfileId === MY_DEFAULT_ROUTER_PROFILE_ID) {
      return { kind: 'myDefault' };
    }
    const profile = routerConfig?.profiles.find((candidate) =>
      candidate.id === source.sourceProfileId && candidate.revision === source.profileRevision
    );
    return profile ? { kind: 'profile', profileName: profile.name } : { kind: 'custom' };
  }
  if (draft.profileId === null) return { kind: 'myDefault' };
  if (draft.profileId === DEFAULT_ONLY_PROFILE_ID) return { kind: 'defaultOnly' };
  const profile = routerConfig?.profiles.find((candidate) => candidate.id === draft.profileId);
  return profile ? { kind: 'profile', profileName: profile.name } : { kind: 'missingProfile' };
}

export interface HistoryRouteSummary {
  runtime_id: string;
  provider?: string;
  router?: {
    launchTransport?: string | null;
    bindings?: Partial<Record<string, string>>;
    defaultEnv?: string | null;
    allowedEnvs?: string[];
    sourceProfileId?: string | null;
    profileRevision?: number | null;
  } | null;
}

export type HistoryRouteRestoreResolution =
  | { kind: 'off' }
  | { kind: 'restored'; draft: ComposerRouteDraft };

/**
 * Restore only an exact-runtime reference. The public summary intentionally
 * is not replayed as a RouterLaunchDraft: it lacks the private auth capability
 * and its allowed-env list is an expanded effective set.
 */
export function resolveHistoryRouteRestore(
  summary: HistoryRouteSummary | null,
): HistoryRouteRestoreResolution {
  const router = summary?.router;
  if (!router || router.launchTransport !== 'routed') return { kind: 'off' };
  const defaultEnv = router.defaultEnv?.trim() ?? '';
  const allowedEnvs = router.allowedEnvs ?? [];
  const isDefaultOnly = Object.keys(router.bindings ?? {}).length === 0
    && defaultEnv.length > 0
    && allowedEnvs.length > 0
    && allowedEnvs.every((env) => env === defaultEnv);
  return {
    kind: 'restored',
    draft: {
      optIn: true,
      profileId: null,
      restoredSource: {
        runtimeId: summary.runtime_id,
        sourceProfileId: router.sourceProfileId ?? null,
        profileRevision: router.profileRevision ?? null,
        isDefaultOnly,
      },
    },
  };
}
