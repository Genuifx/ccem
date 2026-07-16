import { invoke } from '@tauri-apps/api/core';
import { useCallback, useLayoutEffect, useRef } from 'react';
import {
  previewPanelScope,
  previewSurfaceOrdering,
  type PreviewSurfaceOperationResult,
  type PreviewSurfaceOwner,
} from '@/lib/previewSurfaceOrdering';

export type PreviewSurfaceMutationRunner = <T>(
  operation: () => Promise<T>,
) => Promise<PreviewSurfaceOperationResult<T>>;

export function usePreviewSurfaceMutation(sessionId: string | null): PreviewSurfaceMutationRunner {
  const ownerRef = useRef<PreviewSurfaceOwner | null>(null);

  useLayoutEffect(() => {
    if (!sessionId) return;
    const owner = previewSurfaceOrdering.claim(previewPanelScope(sessionId));
    ownerRef.current = owner;

    return () => {
      if (ownerRef.current === owner) ownerRef.current = null;
      void previewSurfaceOrdering.enqueue(owner, () => (
        invoke('browser_set_visible', { sessionId, visible: false })
      )).catch((error) => {
        console.error('Failed to hide retired preview browser surface:', error);
      }).finally(() => previewSurfaceOrdering.release(owner));
    };
  }, [sessionId]);

  return useCallback(<T,>(operation: () => Promise<T>) => {
    const owner = ownerRef.current;
    return owner
      ? previewSurfaceOrdering.enqueue(owner, operation)
      : Promise.resolve({ applied: false });
  }, []);
}
