import { invoke } from '@tauri-apps/api/core';

export interface HermesSource {
  platform: string;
  profile: string;
  transportProfile: string;
  accountRef: string;
  userId: string;
  chatId: string;
  threadId?: string | null;
  chatType: string;
}

export interface HermesPlatform {
  id: string;
  label: string;
  available: boolean;
  strictSend: boolean;
  fields: Array<{ key: string; label: string; secret: boolean; required: boolean }>;
}

export interface HermesPendingPairing {
  id: string;
  source: HermesSource;
  expiresAt: string | number;
}

export interface HermesRoute {
  id: string;
  generation: number;
  source: HermesSource;
  workspaces: string[];
  enabled: boolean;
  allowInput: boolean;
  notifications: boolean;
}

export interface HermesStatus {
  installer: {
    state: string;
    version?: string | null;
    downloadedBytes: number;
    totalBytes?: number | null;
    error?: { code: string; message: string; retryable?: boolean } | string | null;
    retryable: boolean;
  };
  gateway: {
    state: string;
    error?: string | null;
    platforms: HermesPlatform[];
    configuredPlatform?: string | null;
    configuredFields?: string[];
  };
  pairing?: { code: string; expiresAt: string | number } | null;
  pending: HermesPendingPairing[];
  routes: HermesRoute[];
  operations: Array<{ id: string; runtimeId: string; state: string; detail: string; updatedAt: string | number }>;
  deliveries: Array<{ id: string; status: string; createdAt: string | number }>;
  workspaces: string[];
}

export interface HermesActionPayloads {
  install: undefined;
  cancelInstall: undefined;
  removeRuntime: undefined;
  configureChannel: { platform: string; fields: Record<string, string> };
  start: undefined;
  stop: undefined;
  openPairing: undefined;
  approvePairing: { id: string; workspaces: string[]; allowInput: boolean; notifications: boolean };
  disableRoute: { id: string };
}

export type HermesAction = keyof HermesActionPayloads;

export function getHermesStatus(): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_status');
}

export function performHermesAction<A extends HermesAction>(
  action: A,
  payload?: HermesActionPayloads[A],
): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_action', { action, ...(payload ? { payload } : {}) });
}
