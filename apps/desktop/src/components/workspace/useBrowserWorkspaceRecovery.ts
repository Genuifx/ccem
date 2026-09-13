import { useCallback, useEffect, useRef, useState } from 'react';
import {
  awaitBrowserWorkspace,
  currentBrowserWorkspace,
  saveBrowserWorkspace,
} from '@/lib/webcontentRecovery';
import { createBrowserPanelSessionKeyRegistry, type BrowserPanelTarget } from './browserPanelTarget';

/** The host owns the recovery copy; hydrate identities before mounting any browser. */
export function useBrowserWorkspaceRecovery() {
  const [initial] = useState(currentBrowserWorkspace);
  const [ready, setReady] = useState(initial !== undefined);
  const readyRef = useRef(ready);
  const [targets, setTargets] = useState<Record<string, BrowserPanelTarget | undefined>>(
    () => initial?.targets ?? {},
  );
  const targetsRef = useRef(targets);
  const instanceSequenceRef = useRef(initial?.instanceSequence ?? 0);
  const sessionKeyRegistryRef = useRef(createBrowserPanelSessionKeyRegistry(initial?.sessionKeys));

  const persist = useCallback(() => {
    if (!readyRef.current) return;
    void saveBrowserWorkspace({
      version: 1,
      targets: targetsRef.current,
      instanceSequence: instanceSequenceRef.current,
      sessionKeys: sessionKeyRegistryRef.current.snapshot(),
    }).catch(() => {
      // Native acquisition observes this failure and renders its existing retry UI.
      console.warn('Browser workspace recovery metadata could not be saved');
    });
  }, []);

  const updateTargets = useCallback((update: (previous: typeof targets) => typeof targets) => {
    if (!readyRef.current) return targetsRef.current;
    const next = update(targetsRef.current);
    targetsRef.current = next;
    // Enqueue before rendering the new panel, so acquire cannot race its recovery identity.
    persist();
    setTargets(next);
    return next;
  }, [persist]);

  useEffect(() => {
    if (readyRef.current) return;
    let disposed = false;
    void awaitBrowserWorkspace().then((workspace) => {
      if (disposed) return;
      instanceSequenceRef.current = workspace?.instanceSequence ?? 0;
      sessionKeyRegistryRef.current = createBrowserPanelSessionKeyRegistry(workspace?.sessionKeys);
      targetsRef.current = workspace?.targets ?? {};
      readyRef.current = true;
      setTargets(targetsRef.current);
      setReady(true);
    }).catch(() => {
      console.warn('Browser workspace recovery handshake unavailable');
    });
    return () => { disposed = true; };
  }, []);

  // Session aliases can arrive after the first panel. The transport deduplicates snapshots.
  useEffect(persist);

  return { ready, targets, targetsRef, updateTargets, instanceSequenceRef, sessionKeyRegistryRef };
}
