import { invoke } from '@tauri-apps/api/core';

export interface CronHermesNotification {
  routeId: string;
  generation: number;
  subscriptionId?: string;
}

export interface CronHermesDelivery {
  target: CronHermesNotification;
  status: string;
}

export interface HermesNotificationTarget extends CronHermesNotification {
  accountRef: string;
  platform: string;
  label: string;
  chatId: string;
  threadId?: string | null;
  userId: string;
  userName?: string | null;
  chatType: string;
}

export function getHermesNotificationTargets(): Promise<HermesNotificationTarget[]> {
  return invoke('hermes_notification_targets');
}

export interface HermesSessionBinding {
  id: string;
  runtimeId: string;
  routeId: string;
  generation: number;
  title: string;
  modelEnv: string;
  model: string;
  lastDecision: string | null;
  error: string | null;
}

export interface HermesSessionHandoff {
  binding: HermesSessionBinding | null;
  bindingValid: boolean;
  deliveryStatus: string | null;
  targets: (HermesNotificationTarget & { handoffReady: boolean; modelEnv?: string | null })[];
  models: { envName: string; model: string }[];
  defaultModelEnv: string;
}

export function sessionHermesAction(action: 'sessionBinding' | 'bindSession' | 'detachSession', payload: {
  runtimeId: string; routeId?: string; generation?: number; modelEnv?: string; bindingId?: string;
}): Promise<HermesSessionHandoff> {
  return invoke('hermes_action', { action, payload });
}

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
  conversationModel?: { envName: string; model: string } | null;
  toolsMode?: 'native' | 'ccem';
  nativeToolsAvailable?: boolean;
  state: string;
  error?: string | null;
  pending: HermesPendingPairing[];
  pairing?: { code: string; expiresAt: string | number } | null;
}

export interface HermesPendingPairing {
  id: string;
  source: HermesSource;
  userName?: string | null;
  expiresAt: string | number;
}

export interface HermesRoute {
  id: string;
  generation: number;
  revision?: number;
  userName?: string | null;
  source: HermesSource;
  workspaces: string[];
  enabled: boolean;
  allowInput: boolean;
  notifications: boolean;
}

export interface HermesStatus {
  conversationModels?: { envName: string; model: string }[];
  unavailableModels?: { envName: string; reason: string }[];
  // Receipt on configureChannel responses only; never infer it from list order.
  configuredAccountRef?: string;
  installer: {
    state: string;
    version?: string | null;
    launch?: { runtimeRoot: string; python: string; source: string; host: string } | null;
    downloadedBytes: number;
    totalBytes?: number | null;
    phaseCompleted?: number;
    phaseTotal?: number | null;
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
  operations: Array<{
    id: string;
    runtimeId: string;
    state: string;
    detail: string;
    updatedAt: string | number;
    botLabel?: string;
    platform?: string;
    sessionTitle?: string | null;
  }>;
  deliveries: Array<{
    id: string;
    status: string;
    createdAt: string | number;
    botLabel?: string;
    platform?: string;
    preview?: string;
    retryable?: boolean;
  }>;
  workspaces: string[];
}

export interface HermesActionPayloads {
  install: undefined;
  cancelInstall: undefined;
  removeRuntime: undefined;
  configureChannel: { platform: string; fields: Record<string, string>; accountRef?: string; label?: string };
  configureConversation: { accountRef: string; modelEnv: string };
  configureTools: { accountRef: string; toolsMode: 'native' | 'ccem' };
  refreshPlatforms: undefined;
  beginSetup: { platform: string };
  cancelSetup: { id: string };
  start: { accountRef: string };
  stop: { accountRef: string };
  removeChannel: { accountRef: string };
  openPairing: { accountRef: string };
  approvePairing: { accountRef: string; id: string; workspaces: string[]; allowInput: boolean; notifications: boolean };
  updateRoute: { accountRef: string; id: string; generation: number; revision?: number; workspaces: string[]; allowInput: boolean; notifications: boolean };
  disableRoute: { id: string };
  removeRoute: { id: string };
  retryDelivery: { id: string };
}

export type HermesAction = keyof HermesActionPayloads;

export type HermesRunAction = <A extends HermesAction>(action: A, payload?: HermesActionPayloads[A], secrets?: string[]) => Promise<HermesStatus | false>;

export function getHermesStatus(): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_status');
}

export function performHermesAction<A extends HermesAction>(
  action: A,
  payload?: HermesActionPayloads[A],
): Promise<HermesStatus> {
  return invoke<HermesStatus>('hermes_action', { action, ...(payload ? { payload } : {}) });
}

export function openDirectoryDialog(): Promise<string | null> {
  return invoke<string | null>('open_directory_dialog');
}
