import type { NativeSessionSummary } from '@/lib/tauri-ipc';

export interface BrowserActivationRequest {
  runtime_id: string;
  request_id: string;
}

export interface BrowserActivationFinished extends BrowserActivationRequest {
  activated: boolean;
}

export type BrowserAgentStatus = 'pending' | 'ready' | 'disabled' | 'unavailable';
type Rejection = 'disabled' | 'cancelled' | 'unavailable';
type Pending = { request: BrowserActivationRequest; owner?: string; selectionRevision: number; rejected?: boolean };

/** Events only notify. The native request must still be current before the shell opens anything. */
export function createBrowserActivationController(deps: {
  claim(request: BrowserActivationRequest): Promise<NativeSessionSummary>;
  reject(request: BrowserActivationRequest, reason: Rejection): Promise<unknown>;
  ownerFor(session: NativeSessionSummary): string;
  reveal(session: NativeSessionSummary, owner: string): void | (() => void);
}) {
  const pending = new Map<string, Pending>();
  const ownersByRuntime = new Map<string, string>();
  const rollbacks = new Map<string, () => void>();
  const statuses = new Map<string, BrowserAgentStatus>();
  const closed = new Set<string>();
  let selectionRevision = 0;
  let selectedOwner: string | undefined;
  let disposed = false;
  const keyFor = (request: BrowserActivationRequest) => `${request.runtime_id}:${request.request_id}`;

  function rollbackIfUnused(owner: string | undefined) {
    if (!owner || !rollbacks.has(owner)) return;
    if ([...pending.values()].some((entry) => entry.owner === owner && !entry.rejected)) return;
    const rollback = rollbacks.get(owner)!;
    rollbacks.delete(owner);
    // A removed failed panel must not poison the next command's fresh startup.
    if (statuses.get(owner) !== 'disabled') statuses.delete(owner);
    rollback();
  }

  function reject(entry: Pending, reason: Rejection) {
    if (entry.rejected) return;
    // Keep the exact request until native completion so queued retries cannot undo cancellation.
    entry.rejected = true;
    // The backend may already have cancelled or completed the exact request.
    void deps.reject(entry.request, reason).catch(() => {});
    rollbackIfUnused(entry.owner);
  }

  async function request(value: BrowserActivationRequest) {
    if (disposed || !value || typeof value.runtime_id !== 'string'
      || typeof value.request_id !== 'string' || !value.runtime_id || !value.request_id) return;
    const key = keyFor(value);
    if (pending.has(key)) return;
    const entry: Pending = {
      request: value, selectionRevision, owner: ownersByRuntime.get(value.runtime_id),
    };
    pending.set(key, entry);
    try {
      const session = await deps.claim(value);
      if (disposed || entry.rejected || pending.get(key) !== entry) return;
      if (session.runtime_id !== value.runtime_id || !session.is_active
        || session.provider !== 'claude') {
        reject(entry, 'unavailable');
        return;
      }
      entry.owner = deps.ownerFor(session);
      ownersByRuntime.set(value.runtime_id, entry.owner);
      // Other tools may still be validating the same exact runtime. Keep their
      // shared automatic reveal until they too have completed or been rejected.
      for (const other of pending.values()) {
        if (other.request.runtime_id === value.runtime_id) other.owner = entry.owner;
      }
      if (entry.selectionRevision !== selectionRevision && selectedOwner !== entry.owner) {
        reject(entry, 'cancelled');
        return;
      }
      const status = statuses.get(entry.owner);
      if (closed.has(entry.owner) || status === 'disabled' || status === 'unavailable') {
        reject(entry, status === 'unavailable' ? 'unavailable' : 'disabled');
        return;
      }
      const rollback = deps.reveal(session, entry.owner);
      if (rollback && !rollbacks.has(entry.owner)) rollbacks.set(entry.owner, rollback);
      rollbackIfUnused(entry.owner);
    } catch {
      if (pending.get(key) === entry) reject(entry, 'unavailable');
    }
  }

  function status(owner: string, next: BrowserAgentStatus) {
    statuses.set(owner, next);
    // Taking control keeps the browser open even if native activation has not settled yet.
    if (next === 'disabled') rollbacks.delete(owner);
    for (const entry of pending.values()) {
      if (entry.owner !== owner) continue;
      if (next === 'disabled' || next === 'unavailable') reject(entry, next);
      // A ready surface alone does not complete a tool. Native code resolves the exact actor.
    }
  }

  function cancel(owner: string, explicitlyClosed = false) {
    if (explicitlyClosed) {
      closed.add(owner);
      // Workspace applies the user's close/hide itself; do not undo that gesture.
      rollbacks.delete(owner);
    }
    for (const entry of pending.values()) {
      if (entry.owner === owner) reject(entry, explicitlyClosed ? 'disabled' : 'cancelled');
    }
  }

  return {
    request,
    status,
    cancel,
    reopen(owner: string, fresh = false) {
      closed.delete(owner);
      rollbacks.delete(owner);
      if (fresh) statuses.delete(owner);
    },
    selectionChanged(owner: string) {
      if (selectedOwner === owner) return;
      selectedOwner = owner;
      selectionRevision += 1;
      for (const entry of pending.values()) {
        if (entry.owner && entry.owner !== owner) reject(entry, 'cancelled');
      }
    },
    complete(value: BrowserActivationFinished) {
      const key = keyFor(value);
      const entry = pending.get(key);
      if (!entry) return;
      pending.delete(key);
      // Only native exact-route readiness commits the automatic reveal. A late
      // BrowserPanel ready projection can still arrive after native Stop.
      if (value.activated && entry.owner) rollbacks.delete(entry.owner);
      else rollbackIfUnused(entry.owner);
    },
    leaveWorkspace() {
      for (const entry of pending.values()) reject(entry, 'cancelled');
    },
    resume() { disposed = false; },
    dispose() {
      disposed = true;
      for (const entry of pending.values()) reject(entry, 'cancelled');
    },
  };
}
