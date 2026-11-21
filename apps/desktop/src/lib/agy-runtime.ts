import { invoke } from '@tauri-apps/api/core';
import { nativeCreateFailure } from '@/components/workspace/composerSubmissionResult';

export interface AgyRuntimeStatus {
  installed: boolean;
  resolvedPath: string | null;
  customPath: string | null;
  defaultHomeDir: string;
}

export const AGY_AUTH_REQUIRED_PREFIX = 'AGY_AUTH_REQUIRED';

export function agyRuntimeErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return '';
}

export function isAgyAuthRequiredError(error?: unknown): boolean {
  if (error == null) return false;
  const raw = agyRuntimeErrorText(error);
  if (raw.includes(AGY_AUTH_REQUIRED_PREFIX)) return true;
  const failure = nativeCreateFailure(error);
  return failure.detail.includes(AGY_AUTH_REQUIRED_PREFIX);
}

export async function checkAgyInstalled(): Promise<boolean> {
  try {
    return await invoke<boolean>('check_agy_installed');
  } catch {
    return false;
  }
}

export const getAgyRuntimeStatus = () =>
  invoke<AgyRuntimeStatus>('get_agy_runtime_status');

export const setAgyCustomPath = (path: string | null) =>
  invoke<AgyRuntimeStatus>('set_agy_custom_path', { path });

export const loginAgyAccount = () =>
  invoke<void>('login_agent_profile', { provider: 'agy' });
