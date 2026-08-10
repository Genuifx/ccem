/**
 * Synchronous re-entry guard for an async action (e.g. environment delete,
 * router save-as-default, profile generate). React state cannot prevent a
 * second invocation within the SAME tick (the `setBusy(true)` hasn't flushed
 * yet), so a fast double-submit would call the backend twice. `begin()` flips a
 * closure flag synchronously, so a second call in the same tick returns false.
 * The owning hook holds this in a ref.
 */
export interface ReentryGuard {
  /** Returns true the first time and false until `end()` is called. */
  begin(): boolean;
  end(): void;
  readonly busy: boolean;
}

export function createReentryGuard(): ReentryGuard {
  let busy = false;
  return {
    begin() {
      if (busy) return false;
      busy = true;
      return true;
    },
    end() {
      busy = false;
    },
    get busy() {
      return busy;
    },
  };
}

/** Backward-compatible alias for the environment-delete call site (same contract). */
export type DeleteGuard = ReentryGuard;
export const createDeleteGuard = createReentryGuard;
