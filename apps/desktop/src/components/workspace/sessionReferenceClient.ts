import { invoke } from '@tauri-apps/api/core';
import type { ComposerSessionReference, ComposerSessionSnapshot } from './composerSessionReferences';

export interface SessionReferenceClient {
  list: (workingDir: string, currentRuntimeId?: string | null) => Promise<ComposerSessionReference[]>;
  read: (workingDir: string, runtimeId: string) => Promise<ComposerSessionSnapshot>;
  send: (args: { workingDir: string; sourceRuntimeId: string; targetRuntimeId: string; text: string; clientMessageId: string }) => Promise<void>;
}
export const sessionReferenceClient: SessionReferenceClient = {
  list: (workingDir, currentRuntimeId) => invoke('list_workspace_session_references', { workingDir, currentRuntimeId }),
  read: (workingDir, runtimeId) => invoke('read_workspace_session_reference', { workingDir, runtimeId }),
  send: (args) => invoke('send_workspace_session_handoff', args),
};
