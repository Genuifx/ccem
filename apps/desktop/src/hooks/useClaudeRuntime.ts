import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelClaudeRuntimeInstall,
  claudeRuntimeErrorText,
  getClaudeRuntimeStatus,
  installClaudeRuntime,
  isClaudeRuntimeInstalling,
  setClaudeRuntimeRegistry,
  setClaudeRuntimeSource,
  type ClaudeRuntimeSource,
  type ClaudeRuntimeStatus,
} from '@/lib/claude-runtime';

const RUNTIME_CHANGED_EVENT = 'ccem-claude-runtime-changed';

export function useClaudeRuntime() {
  const [status, setStatus] = useState<ClaudeRuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<'source' | 'registry' | 'install' | 'cancel' | null>(null);
  const mountedRef = useRef(false);
  const revisionRef = useRef(0);
  const actionRef = useRef(false);
  const cancellingRef = useRef(false);
  const originRef = useRef({});
  const refreshAfterActionRef = useRef(false);

  const refresh = useCallback(async (probe = false, clearError = true) => {
    const revision = ++revisionRef.current;
    if (probe) setLoading(true);
    try {
      const next = await getClaudeRuntimeStatus(probe);
      if (mountedRef.current && revision === revisionRef.current) {
        setStatus(next);
        if (clearError) setError(null);
      }
    } catch (failure) {
      if (mountedRef.current && revision === revisionRef.current) setError(claudeRuntimeErrorText(failure));
    } finally {
      if (mountedRef.current && revision === revisionRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === originRef.current) return;
      if (actionRef.current || cancellingRef.current) refreshAfterActionRef.current = true;
      else void refresh();
    };
    window.addEventListener(RUNTIME_CHANGED_EVENT, changed);
    return () => {
      mountedRef.current = false;
      revisionRef.current += 1;
      window.removeEventListener(RUNTIME_CHANGED_EVENT, changed);
    };
  }, [refresh]);

  const installing = isClaudeRuntimeInstalling(status) || pending === 'install';
  useEffect(() => {
    if (!installing) return;
    const timer = window.setInterval(() => { void refresh(); }, 1000);
    return () => window.clearInterval(timer);
  }, [installing, refresh]);

  const run = useCallback(async (kind: 'source' | 'registry' | 'install', action: () => Promise<ClaudeRuntimeStatus>) => {
    if (actionRef.current) return null;
    actionRef.current = true;
    revisionRef.current += 1;
    setPending(kind);
    setError(null);
    try {
      const next = await action();
      if (mountedRef.current) {
        revisionRef.current += 1;
        setStatus(next);
      }
      return next;
    } catch (failure) {
      // A failed install can follow an explicitly requested source change.
      // Re-read that persisted choice instead of displaying the old selection.
      await refresh();
      if (mountedRef.current) setError(claudeRuntimeErrorText(failure));
      return null;
    } finally {
      if (mountedRef.current) setPending(null);
      window.dispatchEvent(new CustomEvent(RUNTIME_CHANGED_EVENT, { detail: originRef.current }));
      actionRef.current = false;
      if (refreshAfterActionRef.current && !cancellingRef.current) {
        refreshAfterActionRef.current = false;
        void refresh(false, false);
      }
    }
  }, [refresh]);

  const setSource = useCallback((source: ClaudeRuntimeSource) => run('source', () => setClaudeRuntimeSource(source)), [run]);
  const setRegistry = useCallback((registryUrl: string) => run('registry', () => setClaudeRuntimeRegistry(registryUrl)), [run]);
  const install = useCallback((useManaged = false) => run('install', async () => {
    if (useManaged) await setClaudeRuntimeSource('managed');
    return installClaudeRuntime();
  }), [run]);

  // Cancellation remains available if an install command itself is still awaiting its worker.
  const cancel = useCallback(async () => {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    setPending('cancel');
    try {
      const next = await cancelClaudeRuntimeInstall();
      if (mountedRef.current) {
        revisionRef.current += 1;
        setStatus(next);
        setError(null);
      }
    } catch (failure) {
      if (mountedRef.current) setError(claudeRuntimeErrorText(failure));
    } finally {
      if (mountedRef.current) setPending(actionRef.current ? 'install' : null);
      window.dispatchEvent(new CustomEvent(RUNTIME_CHANGED_EVENT, { detail: originRef.current }));
      cancellingRef.current = false;
      if (refreshAfterActionRef.current && !actionRef.current) {
        refreshAfterActionRef.current = false;
        void refresh(false, false);
      }
    }
  }, [refresh]);

  return { status, error, loading, pending, installing, refresh, setSource, setRegistry, install, cancel };
}
