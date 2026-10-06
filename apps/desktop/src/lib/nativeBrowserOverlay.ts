import { useCallback, useLayoutEffect, useRef, type ForwardedRef, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import { readAppZoom } from '@/hooks/useZoom';
import { currentWebcontentDocumentIdentity, invokeBrowserCommand } from './webcontentRecovery';
import { nativeSurfaceOcclusionStore } from './nativeSurfaceOcclusionStore';
import { createNativeBrowserOverlayManager } from './nativeBrowserOverlayManager';

let manager: ReturnType<typeof createNativeBrowserOverlayManager> | null = null;
let initialization: Promise<boolean> | null = null;
let enabled = false;

export const isNativeBrowserCompositionEnabled = () => enabled;

/** Order the global input barrier before the existing Agent-pause transaction. */
export function waitForNativeBrowserModalSync(): Promise<void> {
  if (!enabled) return Promise.resolve();
  if (!manager) return Promise.reject(new Error('Native browser overlay manager is unavailable'));
  return manager.waitForModalSync();
}

/** Called after the document-recovery fence and before React mounts. */
export function initializeNativeBrowserOverlays(): Promise<boolean> {
  if (initialization) return initialization;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return Promise.resolve(false);
  initialization = (async () => {
    try {
      // Recovery already bounded its handshake. Keep this document in legacy
      // mode if that deadline expired; a late identity must not change layers.
      if (!currentWebcontentDocumentIdentity()) return false;
      if (!CSS.supports('clip-path', 'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0)')) return false;
      if (!await invokeBrowserCommand<boolean>('browser_overlay_initialize')) return false;
      enabled = true;
      document.documentElement.dataset.nativeBrowserComposition = 'true';
      manager = createNativeBrowserOverlayManager({
        document,
        readZoom: readAppZoom,
        isModal: nativeSurfaceOcclusionStore.isOccluded,
        isModalRequested: nativeSurfaceOcclusionStore.hasActiveOverlays,
        send: (snapshot) => invokeBrowserCommand('browser_overlay_sync', { ...snapshot }),
        onError: (error) => console.error('Native browser overlay geometry sync failed:', error),
      });
      const unsubscribe = nativeSurfaceOcclusionStore.subscribe(() => manager?.flush());
      manager.flush();
      let unlisten: (() => void) | null = null;
      let disposed = false;
      void listen<{ x: number; y: number; button: number }>('browser_overlay_pointer_down', ({ payload }) => {
        manager?.pointerDown(payload);
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      }).catch((error) => console.error('Native browser outside-click listener unavailable:', error));
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        unlisten?.();
        manager?.dispose();
        manager = null;
      };
      window.addEventListener('pagehide', dispose, { once: true });
      return true;
    } catch (error) {
      console.warn('Native browser composition unavailable; using surface occlusion:', error);
      return false;
    }
  })();
  return initialization;
}

/** Shared primitives register their real DOM surface, including portaled content. */
export function useNativeBrowserOverlayRef<T extends HTMLElement>(forwardedRef?: ForwardedRef<T>) {
  return useRegisteredRef('overlay', forwardedRef);
}

export function useNativeBrowserBackdropRef<T extends HTMLElement>() {
  return useRegisteredRef<T>('backdrop');
}

function useRegisteredRef<T extends HTMLElement>(kind: 'overlay' | 'backdrop', forwardedRef?: ForwardedRef<T>) {
  const release = useRef<(() => void) | null>(null);
  const current = useRef<T | null>(null);
  const callback = useCallback((element: T | null) => {
    release.current?.();
    current.current = element;
    release.current = element ? manager?.register(element, kind) ?? null : null;
    if (typeof forwardedRef === 'function') forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }, [kind, forwardedRef]);
  useLayoutEffect(() => {
    // React 18 StrictMode replays effects without replaying ref attachment.
    if (current.current && !release.current) release.current = manager?.register(current.current, kind) ?? null;
    return () => { release.current?.(); release.current = null; };
  }, [kind]);
  return callback;
}

export function useNativeBrowserViewport(ref: RefObject<HTMLElement>, active: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element || !manager) return undefined;
    return manager.register(element, 'viewport');
  }, [active, ref]);
}
