import type { HermesPlatform } from '@/lib/hermes-ipc';

export const INSTALLING = new Set(['checking', 'downloading', 'verifying', 'extracting', 'activating']);
export const TRANSITIONING = new Set(['starting', 'stopping', 'configuring', 'reconnecting']);
export const SETUP_CANCELLABLE = new Set(['generating', 'waiting']);
export const SETUP_WAIT_MS = 300_000;

const SETUP_ERROR_KEYS = new Map([
  ['setup_request_failed', 'hermes.scanRequestFailed'],
  ['setup_invalid_response', 'hermes.scanInvalidResponse'],
  ['setup_invalid_credentials', 'hermes.scanInvalidCredentials'],
  ['setup_connection_failed', 'hermes.scanConnectionFailed'],
  ['setup_pairing_failed', 'hermes.scanPairingFailed'],
  ['setup_not_supported', 'hermes.scanNotSupported'],
  ['setup_expired', 'hermes.scanExpired'],
  ['setup_busy_retry', 'hermes.scanBusyRetry'],
  ['setup_already_connecting', 'hermes.scanAlreadyConnecting'],
]);

export function timestamp(value: string | number): number {
  return typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
}

export function errorText(error: unknown, secrets: string[] = []): string {
  let message = typeof error === 'string' ? error
    : error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join('••••••');
  return message;
}

export function setupErrorKey(error: unknown): string {
  return SETUP_ERROR_KEYS.get(errorText(error).trim()) ?? 'hermes.scanError';
}

export function platformAvailabilityKey(platform: HermesPlatform): string | null {
  if (platform.unavailableReason === 'integration_unsupported' || !platform.strictSend) return 'hermes.platformUnsupported';
  if (platform.unavailableReason === 'dependency_missing') return 'hermes.platformDependenciesMissing';
  if (!platform.available) return 'hermes.platformUnavailable';
  return null;
}

export function platformDisplayName(id: string, label: string | undefined, t: (key: string) => string): string {
  if (id === 'wecom') return t('hermes.platformWecom');
  if (id === 'feishu') return t('hermes.platformFeishu');
  return label || id;
}
