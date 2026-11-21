import { useCallback, useEffect, useRef, useState } from 'react';
import {
  agyRuntimeErrorText,
  getAgyRuntimeStatus,
  loginAgyAccount,
  setAgyCustomPath,
  type AgyRuntimeStatus,
} from '@/lib/agy-runtime';

export const AGY_RUNTIME_CHANGED_EVENT = 'ccem-agy-runtime-changed';

export function useAgyRuntime() {
  const [status, setStatus] = useState<AgyRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'path' | 'login' | null>(null);
  const mountedRef = useRef(false);
  const revisionRef = useRef(0);
  const originRef = useRef({});

  const refresh = useCallback(async (showLoading = false) => {
    const revision = ++revisionRef.current;
    if (showLoading) setLoading(true);
    try {
      const next = await getAgyRuntimeStatus();
      if (mountedRef.current && revision === revisionRef.current) {
        setStatus(next);
        setError(null);
      }
      return next;
    } catch (failure) {
      if (mountedRef.current && revision === revisionRef.current) {
        setError(agyRuntimeErrorText(failure) || String(failure));
      }
      return null;
    } finally {
      if (mountedRef.current && revision === revisionRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const handleChanged = (event: Event) => {
      if ((event as CustomEvent).detail === originRef.current) return;
      void refresh();
    };
    window.addEventListener(AGY_RUNTIME_CHANGED_EVENT, handleChanged);
    return () => {
      mountedRef.current = false;
      revisionRef.current += 1;
      window.removeEventListener(AGY_RUNTIME_CHANGED_EVENT, handleChanged);
    };
  }, [refresh]);

  const saveCustomPath = useCallback(async (path: string | null) => {
    setPending('path');
    setError(null);
    try {
      const next = await setAgyCustomPath(path);
      if (mountedRef.current) {
        revisionRef.current += 1;
        setStatus(next);
      }
      window.dispatchEvent(new CustomEvent(AGY_RUNTIME_CHANGED_EVENT, { detail: originRef.current }));
      return next;
    } catch (failure) {
      if (mountedRef.current) {
        setError(agyRuntimeErrorText(failure) || String(failure));
      }
      return null;
    } finally {
      if (mountedRef.current) setPending(null);
    }
  }, []);

  const login = useCallback(async () => {
    setPending('login');
    setError(null);
    try {
      await loginAgyAccount();
      return true;
    } catch (failure) {
      if (mountedRef.current) {
        setError(agyRuntimeErrorText(failure) || String(failure));
      }
      return false;
    } finally {
      if (mountedRef.current) setPending(null);
    }
  }, []);

  return { status, loading, error, pending, refresh, saveCustomPath, login };
}
