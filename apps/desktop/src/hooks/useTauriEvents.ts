import { useEffect, useCallback, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type { RouterStatus } from '@ccem/core/browser';
import type { SessionRouterUpdatedEvent } from '@/lib/tauri-ipc';

/**
 * Generic Tauri event listener hook
 * Automatically manages subscription lifecycle
 */
export function useTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
  deps: React.DependencyList = []
) {
  const handlerRef = useRef(handler);

  // Keep handler ref updated
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let mounted = true;

    const setupListener = async () => {
      try {
        const cleanup = await listen<T>(eventName, (event) => {
          if (mounted) {
            handlerRef.current(event.payload);
          }
        });

        // If component unmounted while listen() was resolving, clean up immediately
        // to prevent leaked listeners that would cause duplicate reloads or stale handlers
        if (!mounted) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      } catch (err) {
        console.error(`Failed to listen to event "${eventName}":`, err);
      }
    };

    setupListener();

    return () => {
      mounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, [eventName, ...deps]);
}

/**
 * Session update event payload from backend
 */
export interface SessionUpdatePayload {
  id: string;
  pid?: number;
  env_name: string;
  perm_mode: string;
  working_dir: string;
  start_time: string;
  status: string;
}

/**
 * Hook to listen for session-updated events
 */
export function useSessionUpdatedEvent(
  handler: (session: SessionUpdatePayload) => void
) {
  useTauriEvent<SessionUpdatePayload>('session-updated', handler);
}

/**
 * Hook to listen for task-completed events (session exited with code 0)
 */
export function useTaskCompletedEvent(
  handler: (session: SessionUpdatePayload) => void
) {
  useTauriEvent<SessionUpdatePayload>('task-completed', handler);
}

/**
 * Hook to listen for task-error events (session exited with non-zero code)
 */
export function useTaskErrorEvent(
  handler: (session: SessionUpdatePayload) => void
) {
  useTauriEvent<SessionUpdatePayload>('task-error', handler);
}

/**
 * Hook to listen for session-interrupted events (terminal window closed)
 */
export function useSessionInterruptedEvent(
  handler: (session: SessionUpdatePayload) => void
) {
  useTauriEvent<SessionUpdatePayload>('session-interrupted', handler);
}

/**
 * Hook to listen for env-changed events
 */
export function useEnvChangedEvent(
  handler: (envName: string) => void
) {
  useTauriEvent<string>('env-changed', handler);
}

/**
 * Hook to listen for perm-changed events
 */
export function usePermChangedEvent(
  handler: (permMode: string) => void
) {
  useTauriEvent<string>('perm-changed', handler);
}

/**
 * Hook to listen for native-session-router-updated events.
 * Backend emits after every successful write (IPC / external control / main-env
 * switch) with the new public SessionRouterState — the source of truth, so the
 * UI never assembles router state itself.
 */
export function useSessionRouterUpdatedEvent(
  handler: (payload: SessionRouterUpdatedEvent) => void
) {
  useTauriEvent<SessionRouterUpdatedEvent>('native-session-router-updated', handler);
}

/**
 * Hook to listen for router-status events (RouterManager lifecycle: disabled /
 * starting / ready / degraded / failed, actual bound port, errors).
 */
export function useRouterStatusEvent(
  handler: (status: RouterStatus) => void
) {
  useTauriEvent<RouterStatus>('router-status', handler);
}

/**
 * Combined hook for all session-related events
 * Provides a simple interface for components that need to react to session changes
 */
export function useSessionEvents(callbacks: {
  onSessionUpdated?: (session: SessionUpdatePayload) => void;
  onEnvChanged?: (envName: string) => void;
  onPermChanged?: (permMode: string) => void;
}) {
  const { onSessionUpdated, onEnvChanged, onPermChanged } = callbacks;

  const handleSessionUpdated = useCallback(
    (session: SessionUpdatePayload) => {
      onSessionUpdated?.(session);
    },
    [onSessionUpdated]
  );

  const handleEnvChanged = useCallback(
    (envName: string) => {
      onEnvChanged?.(envName);
    },
    [onEnvChanged]
  );

  const handlePermChanged = useCallback(
    (permMode: string) => {
      onPermChanged?.(permMode);
    },
    [onPermChanged]
  );

  useTauriEvent<SessionUpdatePayload>('session-updated', handleSessionUpdated);
  useTauriEvent<string>('env-changed', handleEnvChanged);
  useTauriEvent<string>('perm-changed', handlePermChanged);
}
