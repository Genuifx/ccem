import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTauriEvent } from '@/hooks/useTauriEvents';
import type { NativeSessionSummary } from '@/lib/tauri-ipc';
import {
  createBrowserActivationController,
  type BrowserActivationRequest,
  type BrowserActivationFinished,
} from './browserActivation';

export function useNativeBrowserActivation(options: {
  isActive: boolean;
  selectedOwner: string;
  ownerFor(session: NativeSessionSummary): string;
  reveal(session: NativeSessionSummary, owner: string): void | (() => void);
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const controllerRef = useRef<ReturnType<typeof createBrowserActivationController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createBrowserActivationController({
      claim: ({ runtime_id, request_id }) => invoke<NativeSessionSummary>(
        'get_native_browser_activation', { runtimeId: runtime_id, requestId: request_id },
      ),
      reject: ({ runtime_id, request_id }, reason) => invoke('reject_native_browser_activation', {
        runtimeId: runtime_id, requestId: request_id, reason,
      }),
      ownerFor: (session) => optionsRef.current.ownerFor(session),
      reveal: (session, owner) => optionsRef.current.reveal(session, owner),
    });
  }
  const controller = controllerRef.current;
  useTauriEvent<BrowserActivationRequest>('native_browser_activation_requested', (request) => {
    void controller.request(request);
  });
  useTauriEvent<BrowserActivationFinished>('native_browser_activation_finished', controller.complete);
  useEffect(() => controller.selectionChanged(options.selectedOwner), [controller, options.selectedOwner]);
  useEffect(() => {
    if (!options.isActive) controller.leaveWorkspace();
  }, [controller, options.isActive]);
  useEffect(() => {
    controller.resume();
    return () => controller.dispose();
  }, [controller]);
  return controller;
}
