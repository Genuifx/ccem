import { useEffect } from 'react';
import { acknowledgeWebcontentReady, sampleWebcontent } from '@/lib/webcontentRecovery';

/** Ready means React committed the app, not just that HTML finished loading. */
export function useWebcontentLifecycle(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let frame: number | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let acknowledging = false;
    const sample = () => { void sampleWebcontent().catch(() => {}); };
    const acknowledge = () => {
      if (cancelled || acknowledging) return;
      if (retry !== null) {
        clearTimeout(retry);
        retry = null;
      }
      acknowledging = true;
      void acknowledgeWebcontentReady().then((acknowledged) => {
        if (cancelled) return;
        if (acknowledged) sample();
        else {
          acknowledging = false;
          retry = setTimeout(acknowledge, 2000);
        }
      }).catch(() => {
        acknowledging = false;
        if (!cancelled) retry = setTimeout(acknowledge, 2000);
      });
    };
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!cancelled) acknowledge();
      });
    });
    // WebKit can suspend rAF in hidden windows. React has already committed;
    // lack of paint scheduling must not be mistaken for another renderer crash.
    const readyFallback = setTimeout(acknowledge, 1000);
    const interval = setInterval(sample, 30_000);
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      if (retry !== null) clearTimeout(retry);
      clearTimeout(readyFallback);
      clearInterval(interval);
    };
  }, [ready]);
}
