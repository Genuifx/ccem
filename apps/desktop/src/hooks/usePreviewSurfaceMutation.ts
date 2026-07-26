import { invoke } from '@tauri-apps/api/core';
import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import {
  previewPanelScope,
  previewSurfaceOrdering,
  type PreviewSurfaceOperationResult,
  type PreviewSurfaceOwner,
} from '@/lib/previewSurfaceOrdering';

export type PreviewSurfaceMutationRunner = <T>(
  operation: () => Promise<T>,
) => Promise<PreviewSurfaceOperationResult<T>>;

export function usePreviewSurfaceMutation(
  sessionId: string | null,
  closeRequestedRef?: MutableRefObject<boolean>,
  presentationRevision = 0,
): PreviewSurfaceMutationRunner {
  const ownerRef = useRef<PreviewSurfaceOwner | null>(null);
  const presentationRevisionRef = useRef(presentationRevision);
  presentationRevisionRef.current = presentationRevision;

  useLayoutEffect(() => {
    if (!sessionId) return;
    const owner = previewSurfaceOrdering.claim(previewPanelScope(sessionId));
    ownerRef.current = owner;

    return () => {
      if (ownerRef.current === owner) ownerRef.current = null;
      if (closeRequestedRef?.current) {
        previewSurfaceOrdering.release(owner);
        return;
      }
      const retirementPresentationRevision = presentationRevisionRef.current;
      void previewSurfaceOrdering.enqueue(owner, () => (
        invoke('browser_set_visible', {
          sessionId,
          visible: false,
          presentationRevision: retirementPresentationRevision,
        })
      )).catch((error) => {
        console.error('Failed to hide retired preview browser surface:', error);
      }).finally(() => previewSurfaceOrdering.release(owner));
    };
  }, [closeRequestedRef, sessionId]);

  return useCallback(<T,>(operation: () => Promise<T>) => {
    const owner = ownerRef.current;
    return owner
      ? previewSurfaceOrdering.enqueue(owner, operation)
      : Promise.resolve({ applied: false });
  }, []);
}
