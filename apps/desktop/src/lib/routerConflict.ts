/**
 * Pure helpers for CCEM Router CAS conflict handling and operational state.
 *
 * Kept dependency-free (type-only imports, erased at runtime) so it can be
 * transpiled and unit-tested in isolation by the desktop `node:test` harness.
 */
import type { SessionRouterState } from '@ccem/core/browser';

/** Mirrors Rust `router::types::RouterServiceError` (camelCase JSON). */
export interface RouterServiceError {
  code: string;
  message: string;
  /** Present on `ROUTER_REVISION_CONFLICT` so the UI can rebase + retry. */
  current?: SessionRouterState;
}

/** Structural check for the public router state carried on a conflict. */
export function isSessionRouterState(value: unknown): value is SessionRouterState {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.revision === 'number'
    && typeof record.defaultEnv === 'string'
    && (record.launchTransport === 'routed' || record.launchTransport === 'direct')
  );
}

/**
 * Normalize a thrown `invoke` rejection into a RouterServiceError.
 *
 * Tauri may deliver the serialized struct (object) or a stringified form; this
 * defends both so the UI can reliably read `code` and the CAS `current` state.
 * Defensive by design: never throws, always returns a usable error object.
 */
export function extractRouterServiceError(err: unknown): RouterServiceError {
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : 'UNKNOWN';
    const message = typeof record.message === 'string' ? record.message : 'Router request failed';
    const current = isSessionRouterState(record.current)
      ? (record.current as SessionRouterState)
      : undefined;
    return { code, message, current };
  }
  if (typeof err === 'string') {
    const trimmed = err.trim();
    if (trimmed.startsWith('{')) {
      try {
        return extractRouterServiceError(JSON.parse(trimmed));
      } catch {
        // fall through to plain-string handling
      }
    }
    return { code: 'UNKNOWN', message: trimmed || 'Router request failed' };
  }
  return { code: 'UNKNOWN', message: 'Router request failed' };
}

/**
 * Whether the router is operationally active for chip/pill rendering.
 * Anything but a hard `disabled` (or config disabled) counts as active so the
 * user can still reach recovery actions during `starting`/`degraded`/`failed`.
 */
export function isRouterOperational(
  state: string | undefined | null,
  configEnabled: boolean | undefined,
): boolean {
  if (configEnabled === false) return false;
  return state === 'ready' || state === 'starting' || state === 'degraded' || state === 'failed';
}
