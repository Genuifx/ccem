import type { NativeBrowserBounds } from '@/components/workspace/browserPanelGeometry';

export type BrowserSurfaceBackend = 'login';

export type BrowserSurfaceRecoveryState =
  | 'retained_live_host'
  | 'retained_inspection_unknown'
  | 'retained_profile_lock'
  | 'retained_unknown_or_external_owner'
  | 'retained_profile_unavailable'
  | 'recovered_launch_pending'
  | 'recovered_runtime_owned'
  | 'removed_finished_record'
  | 'renderer_process_terminated';

export type BrowserSurfaceProfileSelection =
  | { profileMode: 'default'; profileId?: never }
  | { profileMode: 'new'; profileId?: never }
  | { profileMode: 'saved'; profileId: string };

export type BrowserSurfaceAcquireRequest = {
  panelSessionId: string;
  backend: 'login';
  workingDir: string;
  initialUrl?: string | null;
  viewport: NativeBrowserBounds;
  clientRevision: number;
} & BrowserSurfaceProfileSelection;

export interface BrowserSurfaceSnapshot {
  url?: string | null;
  title?: string | null;
  visible?: boolean;
  loading?: boolean;
  can_go_back?: boolean;
  can_go_forward?: boolean;
  error?: string | null;
  lifecycle?: 'creating' | 'loading' | 'ready' | 'closing' | 'failed' | 'closed';
  control?: 'user' | 'agent' | 'paused';
  paused?: boolean;
  profile_id?: string | null;
  session_status?: 'running' | 'closing' | 'cleanup_required';
  recovery_states?: BrowserSurfaceRecoveryState[];
  popup_active?: boolean;
  popup_url?: string | null;
  popup_title?: string | null;
  popup_loading?: boolean;
  popup_error?: string | null;
}

export interface BrowserSurfaceLease {
  lease_id: string;
  generation: number;
  /** Stable physical CEF surface identity, if the host retained it. */
  surface_id?: string | null;
  client_revision: number;
  server_sequence: number;
  backend: BrowserSurfaceBackend;
  profile_id?: string | null;
  snapshot?: BrowserSurfaceSnapshot | null;
}

export interface BrowserSurfaceStateChangedEvent {
  lease_id: string;
  generation: number;
  client_revision: number;
  server_sequence: number;
  backend: BrowserSurfaceBackend;
  cause: string;
  snapshot?: BrowserSurfaceSnapshot | null;
}

export interface BrowserSurfaceSnapshotMutationResponse {
  lease_id: string;
  generation: number;
  server_sequence: number;
  snapshot: BrowserSurfaceSnapshot;
}

export interface BrowserSurfaceLeaseIdentity {
  leaseId: string;
  generation: number;
  surfaceId?: string | null;
}

export const BROWSER_SURFACE_HOST_SHORTCUT_EVENT = 'browser_surface_host_shortcut';

export type BrowserSurfaceHostShortcutAction =
  | 'open_search'
  | 'open_project'
  | 'submit'
  | 'escape'
  | 'zoom_in'
  | 'zoom_out'
  | 'zoom_reset';

export interface BrowserSurfaceHostShortcutEvent {
  surface_id: string;
  action: BrowserSurfaceHostShortcutAction;
}

export function browserSurfaceEventMatchesLease(
  lease: BrowserSurfaceLeaseIdentity | null,
  event: BrowserSurfaceStateChangedEvent,
): boolean {
  return Boolean(
    lease
    && event.lease_id === lease.leaseId
    && event.generation === lease.generation,
  );
}

export function highestSequencedSurfaceEventForLease(
  lease: BrowserSurfaceLeaseIdentity,
  events: readonly BrowserSurfaceStateChangedEvent[],
): BrowserSurfaceStateChangedEvent | null {
  let highest: BrowserSurfaceStateChangedEvent | null = null;
  for (const event of events) {
    if (
      Number.isSafeInteger(event.server_sequence)
      && event.server_sequence > 0
      && browserSurfaceEventMatchesLease(lease, event)
      && (!highest || event.server_sequence > highest.server_sequence)
    ) {
      highest = event;
    }
  }
  return highest;
}

export interface BrowserSurfaceMutationLane {
  enqueue<T>(operation: (clientRevision: number) => Promise<T>): Promise<T>;
  currentRevision(): number;
}

export interface BrowserSurfaceOrdering extends BrowserSurfaceMutationLane {
  resetServerSequence(): void;
  applySequencedSnapshot(
    serverSequence: number,
    snapshot: BrowserSurfaceSnapshot | null | undefined,
    apply: (snapshot: BrowserSurfaceSnapshot | null | undefined) => void,
  ): boolean;
}

export function createBrowserSurfaceMutationLane(
  initialRevision = 0,
): BrowserSurfaceMutationLane {
  let revision = initialRevision;
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(operation: (clientRevision: number) => Promise<T>): Promise<T> {
      const result = tail.then(() => {
        const nextRevision = revision + 1;
        if (!Number.isSafeInteger(nextRevision) || nextRevision <= 0) {
          throw new Error('Browser surface client revision is exhausted.');
        }
        revision = nextRevision;
        return operation(nextRevision);
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    currentRevision() {
      return revision;
    },
  };
}

export function createBrowserSurfaceOrdering(): BrowserSurfaceOrdering {
  const mutationLane = createBrowserSurfaceMutationLane();
  let lastServerSequence = 0;
  return {
    ...mutationLane,
    resetServerSequence() {
      lastServerSequence = 0;
    },
    applySequencedSnapshot(serverSequence, snapshot, apply) {
      if (!Number.isSafeInteger(serverSequence) || serverSequence <= lastServerSequence) {
        return false;
      }
      lastServerSequence = serverSequence;
      apply(snapshot);
      return true;
    },
  };
}

export function applyBrowserSurfaceMutationResponseForLease(
  ordering: BrowserSurfaceOrdering,
  currentLease: BrowserSurfaceLeaseIdentity | null,
  requestLease: BrowserSurfaceLeaseIdentity,
  response: BrowserSurfaceSnapshotMutationResponse,
  apply: (snapshot: BrowserSurfaceSnapshot | null | undefined) => void,
): boolean {
  if (
    !currentLease
    || currentLease.leaseId !== requestLease.leaseId
    || currentLease.generation !== requestLease.generation
    || response.lease_id !== requestLease.leaseId
    || response.generation !== requestLease.generation
  ) {
    return false;
  }
  return ordering.applySequencedSnapshot(response.server_sequence, response.snapshot, apply);
}

export function browserSurfaceHostShortcutMatchesLease(
  lease: BrowserSurfaceLeaseIdentity | null,
  event: BrowserSurfaceHostShortcutEvent,
): boolean {
  const expectedSurfaceId = lease?.surfaceId
    ?? (lease ? `login-${lease.generation}-${lease.leaseId}` : null);
  return Boolean(
    expectedSurfaceId
    && event.surface_id === expectedSurfaceId,
  );
}

export interface BrowserSurfaceSyncRequest {
  leaseId: string;
  generation: number;
  clientRevision: number;
  presentationRevision: number;
  viewport?: NativeBrowserBounds;
  visible?: boolean;
}

export interface BrowserSurfaceReleaseRequest {
  leaseId: string;
  generation: number;
  clientRevision: number;
  disposition: 'close';
}

export interface BrowserSurfaceNavigateRequest {
  leaseId: string;
  generation: number;
  clientRevision: number;
  url: string;
}

export type BrowserSurfaceNavigationAction = 'back' | 'forward' | 'reload';

export interface BrowserSurfaceNavigationActionRequest {
  leaseId: string;
  generation: number;
  clientRevision: number;
  action: BrowserSurfaceNavigationAction;
}

interface BrowserSurfaceControlRequestBase {
  leaseId: string;
  generation: number;
  clientRevision: number;
}

export type BrowserSurfaceControlRequest = BrowserSurfaceControlRequestBase & (
  | {
      action: 'handoff';
      /** Trusted native runtime selected by the host UI. */
      agentSessionId: string;
    }
  | {
      action: 'pause' | 'takeover' | 'occlude';
      agentSessionId?: never;
    }
);

export interface BrowserSurfaceClosePopupRequest {
  leaseId: string;
  generation: number;
  clientRevision: number;
}

interface BrowserSurfaceIpcDependencies {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

export function createBrowserSurfaceClient(dependencies: BrowserSurfaceIpcDependencies) {
  return {
    acquire: (request: BrowserSurfaceAcquireRequest) =>
      dependencies.invoke<BrowserSurfaceLease>('browser_surface_acquire', { ...request }),
    sync: (request: BrowserSurfaceSyncRequest) =>
      dependencies.invoke<void>('browser_surface_sync', { ...request }),
    release: (request: BrowserSurfaceReleaseRequest) =>
      dependencies.invoke<void>('browser_surface_release', { ...request }),
    navigate: (request: BrowserSurfaceNavigateRequest) =>
      dependencies.invoke<void>('browser_surface_navigate', { ...request }),
    navigationAction: (request: BrowserSurfaceNavigationActionRequest) =>
      dependencies.invoke<BrowserSurfaceSnapshotMutationResponse>(
        'browser_surface_navigation_action',
        { ...request },
      ),
    control: (request: BrowserSurfaceControlRequest) =>
      dependencies.invoke<BrowserSurfaceSnapshotMutationResponse>('browser_surface_control', {
        ...request,
      }),
    closePopup: (request: BrowserSurfaceClosePopupRequest) =>
      dependencies.invoke<BrowserSurfaceSnapshotMutationResponse>('browser_surface_close_popup', {
        ...request,
      }),
  };
}
