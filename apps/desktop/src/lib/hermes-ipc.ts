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
  qrSetup?: boolean;
  unavailableReason?: 'dependency_missing' | 'integration_unsupported' | null;
  setupUrl?: string | null;
  setupService?: string | null;
  commandPrefix?: string;
  fields: Array<{ key: string; label: string; secret: boolean; required: boolean }>;
}

export interface HermesSetup {
  id: string;
  platform: string;
  state: 'generating' | 'waiting' | 'connecting' | 'connected' | 'expired' | 'cancelled' | 'error';
  qrPayload?: string;
  expiresAt?: number;
  error?: string;
  accountRef?: string | null;
}

export interface HermesConnection {
  accountRef: string;
  platform: string;
  label: string;
  configuredFields: string[];
  enabled: boolean;
  state: string;
  error?: string | null;
  pending: HermesPendingPairing[];
  pairing?: { code: string; expiresAt: string | number } | null;
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
    launch?: { runtimeRoot: string; python: string; source: string; host: string } | null;
    downloadedBytes: number;
    totalBytes?: number | null;
    error?: { code: string; message: string; retryable?: boolean } | string | null;
    retryable: boolean;
  };
  gateway: {
    state: string;
    error?: string | null;
    platforms: HermesPlatform[];
  };
  connections: HermesConnection[];
  setup?: HermesSetup | null;
  routes: HermesRoute[];
  operations: Array<{ id: string; runtimeId: string; state: string; detail: string; updatedAt: string | number }>;
  deliveries: Array<{ id: string; status: string; createdAt: string | number }>;
  workspaces: string[];
}

export interface HermesActionPayloads {
  install: undefined;
  cancelInstall: undefined;
  removeRuntime: undefined;
  configureChannel: { platform: string; fields: Record<string, string>; accountRef?: string; label?: string };
  refreshPlatforms: undefined;
  beginSetup: { platform: string };
  cancelSetup: { id: string };
  start: { accountRef: string };
  stop: { accountRef: string };
  removeChannel: { accountRef: string };
  openPairing: { accountRef: string };
  approvePairing: { accountRef: string; id: string; workspaces: string[]; allowInput: boolean; notifications: boolean };
  disableRoute: { id: string };
}

export type HermesAction = keyof HermesActionPayloads;

export type HermesRunAction = <A extends HermesAction>(action: A, payload?: HermesActionPayloads[A], secrets?: string[]) => Promise<boolean>;

export function getHermesStatus(): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_status');
}

export function performHermesAction<A extends HermesAction>(
  action: A,
  payload?: HermesActionPayloads[A],
): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_action', { action, ...(payload ? { payload } : {}) });
}
