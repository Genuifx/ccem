import type { RouterConfig, RouterLaunchDraft } from '@ccem/core/browser';
import type { WorkspaceComposerProvider } from './composerCapabilities';
import { MY_DEFAULT_ROUTER_PROFILE_ID } from '@/lib/routerProfiles';

export { MY_DEFAULT_ROUTER_PROFILE_ID };

/**
 * Per-Composer Dynamic Routing opt-in draft (frontend-only state).
 *
 * This is NOT the session's routed/direct transport truth (that is
 * `SessionRouterState.launchTransport`, owned by the backend) and NOT the
 * Agent explicit-override switch (`dynamicRouting`, an agent-env-override
 * allowance). It only records the opt-in and the chosen source; the actual
 * snapshot is read from the CURRENT RouterConfig at submit time. Every new
 * Composer starts opted out; the draft resets after a successful launch and
 * is cleared when the provider cannot route.
 */
export interface ComposerRouteDraft {
  optIn: boolean;
  /** Selected named profile; null = "my defaults" (RouterConfig snapshot at submit). */
  profileId: string | null;
}

export type RouterLaunchDraftResolution =
  | { ok: true; value: RouterLaunchDraft }
  | { ok: false; code: 'NOT_OPTED_IN' | 'PROFILE_MISSING' | 'CONFIG_UNAVAILABLE' };

export type ComposerRouteDraftLabel =
  | { kind: 'myDefault' }
  | { kind: 'profile'; profileName: string }
  | { kind: 'missingProfile' };

export function createComposerRouteDraft(): ComposerRouteDraft {
  return { optIn: false, profileId: null };
}

/** Off is a full reset: re-enabling starts from the my-defaults snapshot. */
export function toggleComposerRouteDraft(optIn: boolean): ComposerRouteDraft {
  return optIn ? { optIn: true, profileId: null } : createComposerRouteDraft();
}

export function resetComposerRouteDraft(): ComposerRouteDraft {
  return createComposerRouteDraft();
}

/** Plus-menu "动态路由" row is only offered for routing-capable providers. */
export function isRouteDraftRowVisible(provider: WorkspaceComposerProvider | 'opencode'): boolean {
  return provider === 'claude';
}

/** The draft route pill renders above the textarea only for opted-in drafts. */
export function isRouteDraftPillVisible(
  draft: ComposerRouteDraft | null | undefined,
  provider: WorkspaceComposerProvider,
): boolean {
  return Boolean(draft?.optIn) && isRouteDraftRowVisible(provider);
}

/**
 * Resolve the launch seed at submit time from the CURRENT RouterConfig (store
 * truth), never from a render-time snapshot, so a profile edited between
 * enabling and submitting is honored. Blocking codes keep the draft intact so
 * the user can fix the selection and retry.
 */
export function resolveRouterLaunchDraft(
  draft: ComposerRouteDraft,
  routerConfig: RouterConfig | null,
): RouterLaunchDraftResolution {
  if (!draft.optIn) {
    return { ok: false, code: 'NOT_OPTED_IN' };
  }
  if (!routerConfig) {
    return { ok: false, code: 'CONFIG_UNAVAILABLE' };
  }

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

  const profile = routerConfig.profiles.find((p) => p.id === draft.profileId);
  if (!profile) {
    return { ok: false, code: 'PROFILE_MISSING' };
  }
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

/** Pill label: my-defaults snapshot vs the selected named profile. */
export function resolveRouteDraftLabel(
  draft: ComposerRouteDraft,
  routerConfig: RouterConfig | null,
): ComposerRouteDraftLabel {
  if (draft.profileId === null) {
    return { kind: 'myDefault' };
  }
  const profile = routerConfig?.profiles.find((p) => p.id === draft.profileId);
  if (!profile) {
    return { kind: 'missingProfile' };
  }
  return { kind: 'profile', profileName: profile.name };
}
