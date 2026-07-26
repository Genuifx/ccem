import type { BrowserSurfaceProfileSelection } from '@/lib/browserSurfaceIpc';
import type { NativeSessionSummary } from '@/lib/tauri-ipc';

const TERMINAL_BROWSER_AGENT_RUNTIME_STATUSES = new Set([
  'stopped',
  'error',
  'handoff',
  'interrupted',
  'closed_idle',
  'permission_quarantined',
]);

/**
 * A compose draft has no provider session yet, so keep it visibly separate
 * from real CCEM sessions instead of accidentally sharing the legacy
 * workspace-wide browser slot.
 */
export const WORKSPACE_BROWSER_COMPOSE_SESSION_ID = 'draft:workspace';

/**
 * Semantic ownership and native surface lifetime are independent. Every new
 * instance gets a distinct native id, so a late release can never target a
 * reopened BrowserPanel for the same semantic session.
 */
export function createBrowserPanelSurfaceSessionId(
  ownerSessionId: string,
  instanceId: number,
): string {
  return `${ownerSessionId}:${instanceId}`;
}

export interface BrowserPanelLiveSessionIdentity {
  provider: string;
  providerSessionId?: string | null;
  runtimeId: string;
}

/**
 * Prefer the provider's durable session id so a history entry and its restored
 * live runtime address the same BrowserPanel. A runtime-only session still gets
 * an explicit namespace until it receives a provider session id.
 */
export function resolveLiveBrowserPanelSessionKey({
  provider,
  providerSessionId,
  runtimeId,
}: BrowserPanelLiveSessionIdentity): string {
  const stableProviderSessionId = providerSessionId?.trim();
  if (stableProviderSessionId) {
    return `${provider}:${stableProviderSessionId}`;
  }
  return `runtime:${runtimeId}`;
}

/**
 * Keeps a live panel's instance key fixed when a provider session id arrives
 * after the runtime starts. History resolves through that same entry while the
 * runtime is alive, rather than remounting and closing its native surface.
 */
export function createBrowserPanelSessionKeyRegistry() {
  const keyByRuntimeId = new Map<string, string>();
  const keyByProviderSessionId = new Map<string, string>();

  const providerSessionKey = (
    provider: string,
    providerSessionId?: string | null,
  ): string | null => {
    const stableProviderSessionId = providerSessionId?.trim();
    return stableProviderSessionId ? `${provider}:${stableProviderSessionId}` : null;
  };

  const resolveLive = (identity: BrowserPanelLiveSessionIdentity): string => {
    const providerKey = providerSessionKey(identity.provider, identity.providerSessionId);
    const key = keyByRuntimeId.get(identity.runtimeId)
      ?? (providerKey ? keyByProviderSessionId.get(providerKey) : undefined)
      ?? resolveLiveBrowserPanelSessionKey(identity);
    keyByRuntimeId.set(identity.runtimeId, key);
    if (providerKey) keyByProviderSessionId.set(providerKey, key);
    return key;
  };

  return {
    resolveLive,
    resolveHistory({
      provider,
      providerSessionId,
      matchingLiveSession,
    }: {
      provider: string;
      providerSessionId: string;
      matchingLiveSession?: BrowserPanelLiveSessionIdentity | null;
    }): string {
      if (
        matchingLiveSession
        && matchingLiveSession.provider === provider
        && matchingLiveSession.providerSessionId?.trim() === providerSessionId
      ) {
        return resolveLive(matchingLiveSession);
      }
      return keyByProviderSessionId.get(`${provider}:${providerSessionId}`)
        ?? `${provider}:${providerSessionId}`;
    },
  };
}

interface BrowserPanelTargetBase {
  /** Changes only when a closed panel starts a new native instance. */
  instanceId: number;
  /** Immutable native handle; semantic session ownership may be rebound. */
  surfaceSessionId: string;
  initialUrl?: string | null;
  /** A later launcher URL reuses the instance and is handled as navigate. */
  navigationRequestId?: number;
  navigationUrl?: string | null;
  /** Hidden panels retain their mounted React component and native lease. */
  visible?: boolean;
}

export interface PreviewBrowserPanelTarget extends BrowserPanelTargetBase {
  backend: 'preview';
  /** Native runtime alias whose Agent browser tools must resolve to this physical instance. */
  agentSessionId?: string;
}

export type LoginBrowserPanelRequest = {
  workingDir: string;
  initialUrl?: string | null;
} & BrowserSurfaceProfileSelection;

export type LoginBrowserPanelTarget = BrowserPanelTargetBase & {
  backend: 'login';
  workingDir: string;
} & BrowserSurfaceProfileSelection;

export type BrowserPanelTarget = PreviewBrowserPanelTarget | LoginBrowserPanelTarget;

export function resolveActiveBrowserAgentSessionId(
  session: Pick<NativeSessionSummary, 'runtime_id' | 'status' | 'is_active'> | null | undefined,
): string | null {
  if (
    !session?.is_active
    || TERMINAL_BROWSER_AGENT_RUNTIME_STATUSES.has(session.status)
  ) {
    return null;
  }
  return session.runtime_id.trim() || null;
}

export function isBrowserPanelTargetVisible(
  target: BrowserPanelTarget | null | undefined,
): boolean {
  return target?.visible !== false;
}

export function setBrowserPanelTargetVisible(
  target: BrowserPanelTarget,
  visible: boolean,
): BrowserPanelTarget {
  return target.visible === visible ? target : { ...target, visible };
}

export function setPreviewBrowserPanelAgentSessionId(
  target: BrowserPanelTarget,
  agentSessionId: string | null | undefined,
): BrowserPanelTarget {
  if (target.backend !== 'preview') return target;
  const normalized = agentSessionId?.trim() || undefined;
  return target.agentSessionId === normalized
    ? target
    : { ...target, agentSessionId: normalized };
}

/** Finds the semantic owner for a native event emitted by a retained surface. */
export function findBrowserPanelOwnerSessionIdBySurfaceSessionId(
  targets: Record<string, BrowserPanelTarget | undefined>,
  surfaceSessionId: string,
): string | null {
  return Object.entries(targets).find(([, target]) => (
    target?.surfaceSessionId === surfaceSessionId
  ))?.[0] ?? null;
}

/**
 * Reassigns a still-mounted panel from a compose draft to its newly-created
 * live session. The target object and native surface id deliberately stay
 * unchanged, so React can retain the instance while ownership changes.
 */
export function rebindBrowserPanelTarget(
  targets: Record<string, BrowserPanelTarget | undefined>,
  fromSessionId: string,
  toSessionId: string,
): Record<string, BrowserPanelTarget | undefined> {
  if (fromSessionId === toSessionId || !targets[fromSessionId]) {
    return targets;
  }

  const next = { ...targets };
  const target = next[fromSessionId]!;
  delete next[fromSessionId];
  if (!next[toSessionId]) {
    next[toSessionId] = target;
  }
  return next;
}
