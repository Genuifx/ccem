import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  nativeSurfaceOcclusionStore,
  type NativeSurfaceOcclusionParticipant,
} from './nativeSurfaceOcclusionStore';

/**
 * Gates a webview overlay until every native surface has acknowledged hide.
 * Overlapping overlays share the same barrier and restore only after the last
 * overlay has rendered closed.
 */
export function useNativeSurfaceOcclusion(active: boolean): boolean {
  const requestSequenceRef = useRef(0);
  const previousActiveRef = useRef(false);
  const [readySequence, setReadySequence] = useState(0);

  if (active !== previousActiveRef.current) {
    previousActiveRef.current = active;
    if (active) requestSequenceRef.current += 1;
  }
  const requestSequence = requestSequenceRef.current;

  useLayoutEffect(() => {
    if (!active) return undefined;
    let disposed = false;
    const lease = nativeSurfaceOcclusionStore.acquire();
    void lease.ready.then(() => {
      if (!disposed) setReadySequence(requestSequence);
    }).catch((error) => {
      if (!disposed) {
        console.error('Native surface hide barrier failed; overlay remains closed:', error);
      }
    });

    return () => {
      disposed = true;
      void lease.release().catch((error) => {
        console.error('Failed to restore native surfaces after overlay close:', error);
      });
    };
  }, [active, requestSequence]);

  return active && readySequence === requestSequence;
}

/** Registers a BrowserPanel as an acknowledgement-bearing native participant. */
export function useNativeSurfaceOcclusionParticipant(
  participant: NativeSurfaceOcclusionParticipant,
  active = true,
): void {
  const participantRef = useRef(participant);
  participantRef.current = participant;

  useLayoutEffect(() => {
    if (!active) return undefined;
    return nativeSurfaceOcclusionStore.registerParticipant({
      prepareHide: () => participantRef.current.prepareHide?.(),
      hide: () => participantRef.current.hide(),
      restore: () => participantRef.current.restore(),
    });
  }, [active]);
}

export function useNativeSurfaceOccluded(): boolean {
  return useSyncExternalStore(
    nativeSurfaceOcclusionStore.subscribe,
    nativeSurfaceOcclusionStore.isOccluded,
    () => false,
  );
}
