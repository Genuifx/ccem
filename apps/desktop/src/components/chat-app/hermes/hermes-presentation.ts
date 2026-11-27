import type { HermesPlatform } from '@/lib/hermes-ipc';

export const INSTALLING = new Set(['checking', 'downloading', 'verifying', 'extracting', 'health_check', 'verifying_final', 'activating']);
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

const HERMES_ERROR_CODES = new Set([
  'route_authority_changed',
  'route_not_found',
  'pairing_expired',
  'pairing_not_found',
  'workspace_not_authorized',
  'hermes_concrete_model_required',
  'hermes_oauth_not_supported',
  'hermes_env_missing_auth',
  'hermes_env_not_found',
  'hermes_env_disabled',
  'hermes_model_env_required',
  'hermes_handoff_not_ready',
  'session_not_found',
  'confirmation_expired',
  'confirmation_not_found',
  'ambiguous_confirmation',
  'channel_not_configured',
  'channel_already_running',
  'runtime_not_installed',
  'runtime_busy',
  'delivery_not_retryable',
  'delivery_not_found',
  'challenge_required',
  'runtime_id_required',
  'text_required',
  'cwd_required',
  'invalid_cwd',
]);

const LEGACY_OPERATION_DETAIL_KEYS = new Map([
  ['Waiting for chat confirmation', 'hermes.opWaitingConfirmation'],
  ['Confirmation cancelled', 'hermes.opCancelled'],
  ['Confirmation expired', 'hermes.opExpired'],
  ['Submitting to CCEM session', 'hermes.opSubmitting'],
  ['Submitted to CCEM session', 'hermes.opSubmitted'],
  ['Submission failed', 'hermes.opFailed'],
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

export function localizeHermesError(error: unknown, t: (key: string) => string, secrets: string[] = []): string {
  const raw = errorText(error, secrets);
  const code = raw.trim();
  if (code === 'hermes_native_tools_update_required') return t('hermes.nativeToolsUpdateRequired');
  if (code === 'pairing_rate_limited') return t('hermes.pairingRateLimited');
  if (HERMES_ERROR_CODES.has(code)) {
    return t(`hermes.error_${code}`);
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && HERMES_ERROR_CODES.has(error.code)) {
    const key = `hermes.error_${error.code}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return raw;
}

export function localizeOperationDetail(detail: string, t: (key: string) => string): string {
  const key = LEGACY_OPERATION_DETAIL_KEYS.get(detail.trim());
  if (!key) return detail;
  const translated = t(key);
  return translated === key ? detail : translated;
}

export function fieldDisplayLabel(field: { key: string; label: string }, t: (key: string) => string): string {
  const key = `hermes.field_${field.key}`;
  const translated = t(key);
  return translated !== key ? translated : (field.label || field.key);
}

export function formatPairedUser(userName: string | null | undefined, userId: string): string {
  const shortId = userId.length > 18 ? `${userId.slice(0, 8)}…${userId.slice(-4)}` : userId;
  const cleanName = userName?.trim();
  return cleanName ? `${cleanName} (${shortId})` : shortId;
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
