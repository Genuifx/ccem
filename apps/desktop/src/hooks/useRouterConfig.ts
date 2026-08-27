import { useCallback, useEffect } from 'react';
import { useAppStore } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import {
  createCommitQueue,
  runConfigCommit,
  type CommitQueue,
  type RouterConfigUpdater,
} from '@/lib/routerProfiles';
import type { RouterConfig, RouterStatus } from '@ccem/core/browser';

// Module-level singleton commit queue: serializes EVERY global RouterConfig edit
// across all hook consumers (Settings / Environments / Workspace). A per-instance
// queue would let two pages save the full config concurrently and the later save
// — built on a stale store snapshot — would clobber the other's port/profiles.
// Each queued task still reads useAppStore's CURRENT base at execution time (see
// `commit`), so serialized edits compose on fresh state.
let globalCommitQueue: CommitQueue | null = null;
function getGlobalCommitQueue(): CommitQueue {
  if (!globalCommitQueue) globalCommitQueue = createCommitQueue();
  return globalCommitQueue;
}

/**
 * Single source of truth for editing the GLOBAL `~/.ccem/config.json` router
 * section, shared by Settings and the Environments page.
 *
 * Contract (see lib/routerProfiles.ts `runConfigCommit` + `createCommitQueue`,
 * both unit-tested):
 *  - Forms read the store's authoritative `routerConfig`; no optimistic mirror.
 *  - `commit(updater)` takes a FUNCTION `(base) => patch` computed against the
 *    FRESH base at execution time → rapid queued edits compose, no stale overwrite.
 *  - Commits are GLOBALLY serialized via a module-level singleton queue shared by
 *    every hook consumer (Settings / Environments / Workspace), so concurrent
 *    full-config saves cannot clobber each other. A failed commit does NOT poison
 *    the chain.
 *  - `onCommit` always writes the store (no mount gate): Zustand setters are safe
 *    to call after the owning component unmounts, and skipping would leave a stale
 *    base for the next serialized commit and let it clobber this one.
 *  - On save failure the backend may have already persisted a partial/new config
 *    (Rust persists config before applying the listener), so we RELOAD
 *    settings+status to surface the real truth before rejecting to the caller.
 */
export function useRouterConfigEditor() {
  const config = useAppStore((s) => s.routerConfig);
  const status = useAppStore((s) => s.routerStatus);
  const setRouterConfig = useAppStore((s) => s.setRouterConfig);
  const setRouterStatus = useAppStore((s) => s.setRouterStatus);
  const { loadRouterSettings, saveRouterSettings, loadRouterStatus } = useTauriCommands();

  // Lazy-load once on mount if the Workspace boot load hasn't populated it yet.
  useEffect(() => {
    if (!useAppStore.getState().routerConfig) {
      void loadRouterSettings().catch(() => undefined);
    }
    if (!useAppStore.getState().routerStatus) {
      void loadRouterStatus().catch(() => undefined);
    }
  }, [loadRouterSettings, loadRouterStatus]);

  const reload = useCallback(async () => {
    // loadRouterSettings/loadRouterStatus each write the store to the backend's
    // current truth (their own setRouterConfig/setRouterStatus on success).
    await Promise.all([
      loadRouterSettings().catch(() => undefined),
      loadRouterStatus().catch(() => undefined),
    ]);
  }, [loadRouterSettings, loadRouterStatus]);

  const commit = useCallback(
    async (updater: RouterConfigUpdater): Promise<RouterConfig | null> => {
      return getGlobalCommitQueue().enqueue(() =>
        runConfigCommit({
          base: useAppStore.getState().routerConfig,
          updater,
          save: saveRouterSettings,
          reload,
          onCommit: (next: RouterConfig, newStatus: RouterStatus) => {
            // ALWAYS write the authoritative store. These are global Zustand
            // setters (safe to call after the owning component unmounts); gating
            // on a mount flag would leave a stale base for the next serialized
            // commit and let it clobber this one.
            setRouterConfig(next);
            setRouterStatus(newStatus);
          },
        }),
      );
    },
    [saveRouterSettings, reload, setRouterConfig, setRouterStatus],
  );

  return { config, status, commit, reload };
}
