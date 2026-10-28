import { invoke } from '@tauri-apps/api/core';
import { nativeCreateFailure } from '@/components/workspace/composerSubmissionResult';

export type ClaudeRuntimeSource = 'auto' | 'system' | 'managed';

export interface ClaudeRuntimeCandidate {
  state: 'available' | 'missing' | 'incompatible' | 'error';
  path: string | null;
  version: string | null;
  detail: string | null;
}

export interface ClaudeRuntimeStatus {
  preference: ClaudeRuntimeSource;
  recommendedVersion: string;
  minimumSystemVersion: string;
  system: ClaudeRuntimeCandidate;
  managed: ClaudeRuntimeCandidate;
  selected: { source: 'system' | 'managed'; path: string; version: string } | null;
  install: {
    state: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'installed' | 'cancelled' | 'error';
    downloadedBytes: number;
    totalBytes: number | null;
    error: string | null;
  };
  supported: boolean;
  unsupportedReason: string | null;
}

export const getClaudeRuntimeStatus = (refresh = false) =>
  invoke<ClaudeRuntimeStatus>('get_claude_runtime_status', { refresh });
export const setClaudeRuntimeSource = (source: ClaudeRuntimeSource) =>
  invoke<ClaudeRuntimeStatus>('set_claude_runtime_source', { source });
export const installClaudeRuntime = () => invoke<ClaudeRuntimeStatus>('install_claude_runtime');
export const cancelClaudeRuntimeInstall = () => invoke<ClaudeRuntimeStatus>('cancel_claude_runtime_install');

export function isClaudeRuntimeInstalling(status: ClaudeRuntimeStatus | null): boolean {
  return Boolean(status && ['downloading', 'verifying', 'extracting'].includes(status.install.state));
}

/** Only a certified, pre-launch rejection may open setup and keep a retryable draft. */
export function isClaudeRuntimeRequiredError(error: unknown): boolean {
  const failure = nativeCreateFailure(error);
  return failure.result === false && failure.detail.startsWith('CLAUDE_RUNTIME_REQUIRED:');
}

/** Login carries no message, and its command returns the resolver error directly. */
export function isClaudeRuntimeLoginRequiredError(error: unknown): boolean {
  return claudeRuntimeErrorText(error).startsWith('CLAUDE_RUNTIME_REQUIRED:');
}

export function claudeRuntimeErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return '';
}
