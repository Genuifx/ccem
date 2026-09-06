import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type StartupPhase = 'preparing' | 'configuration' | 'checkingSessions'
  | 'restoringSessions' | 'startingServices' | 'ready' | 'failed';

// A single-flight poll waits for native recovery. A UI timeout must never open
// the workspace while recovery could still reconcile newly-created sessions.
export function useStartup(loadConfiguration: () => Promise<unknown>) {
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<StartupPhase>('preparing');
  useEffect(() => {
    let cancelled = false;
    let configured = false;
    let nativeReady = false;
    let pollTimer: number | undefined;
    let finishTimer: number | undefined;
    let requestTimer: number | undefined;
    let lastResponseAt = performance.now();
    const startedAt = performance.now();
    const finish = () => {
      if (cancelled || !configured || !nativeReady) return;
      finishTimer = window.setTimeout(() => {
        if (!cancelled) { setPhase('ready'); setReady(true); }
      }, Math.max(0, 760 - (performance.now() - startedAt)));
    };
    // Preserve the existing best-effort configuration deadline, independently
    // of the native recovery gate. Late config results can still hydrate state.
    const configurationDone = () => {
      if (cancelled || configured) return;
      configured = true;
      window.clearTimeout(configTimer);
      finish();
    };
    const configTimer = window.setTimeout(configurationDone, 4800);
    void loadConfiguration().then(configurationDone, configurationDone);

    const poll = async () => {
      try {
        const status = await Promise.race([
          invoke<StartupPhase>('get_startup_status'),
          new Promise<never>((_, reject) => {
            requestTimer = window.setTimeout(() => reject(new Error('Startup status timed out')), 5000);
          }),
        ]);
        if (cancelled) return;
        lastResponseAt = performance.now();
        if (status === 'failed') { setPhase('failed'); return; }
        nativeReady = status === 'ready';
        setPhase(nativeReady ? 'configuration' : status);
        if (nativeReady) { finish(); return; }
      } catch {
        if (cancelled) return;
        // A failed bridge read is not proof recovery finished.
        if (performance.now() - lastResponseAt >= 30_000) { setPhase('failed'); return; }
        setPhase('preparing');
      } finally {
        window.clearTimeout(requestTimer);
        requestTimer = undefined;
      }
      pollTimer = window.setTimeout(poll, 250);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(configTimer);
      window.clearTimeout(pollTimer);
      window.clearTimeout(finishTimer);
      window.clearTimeout(requestTimer);
    };
  }, [loadConfiguration]);
  return { ready, phase };
}
