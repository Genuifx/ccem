import type { RefObject } from 'react';
import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CCEM_ZOOM_CHANGE_EVENT } from './useZoom';

export function useNativeBrowserSurfaceGeometrySync(
  frameRef: RefObject<HTMLDivElement>,
  syncBounds: () => void,
) {
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    let disposed = false;
    const nativeWindowUnlisteners: Array<() => void> = [];
    const currentWindow = getCurrentWindow();
    const observer = new ResizeObserver(syncBounds);
    observer.observe(frame);
    window.addEventListener('resize', syncBounds);
    window.addEventListener(CCEM_ZOOM_CHANGE_EVENT, syncBounds);
    const timeoutId = window.setTimeout(syncBounds, 80);

    void Promise.all([
      currentWindow.onMoved(syncBounds),
      currentWindow.onResized(syncBounds),
      currentWindow.onScaleChanged(syncBounds),
      currentWindow.onFocusChanged(syncBounds),
    ]).then((unlisteners) => {
      if (disposed) {
        unlisteners.forEach((unlisten) => unlisten());
        return;
      }
      nativeWindowUnlisteners.push(...unlisteners);
    }).catch((listenError) => {
      console.error('Failed to watch native browser surface geometry:', listenError);
    });

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      window.removeEventListener('resize', syncBounds);
      window.removeEventListener(CCEM_ZOOM_CHANGE_EVENT, syncBounds);
      nativeWindowUnlisteners.forEach((unlisten) => unlisten());
      observer.disconnect();
    };
  }, [frameRef, syncBounds]);
}
