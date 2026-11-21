import { setTimeout as sleep } from 'node:timers/promises';

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);
export const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function isTransientTransportError(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error) || error instanceof SyntaxError) return false;
  seen.add(error);
  return TRANSIENT_CODES.has(error.code) || error.name === 'TimeoutError'
    || isTransientTransportError(error.cause, seen)
    || (Array.isArray(error.errors) && error.errors.length > 0
      && error.errors.every((entry) => isTransientTransportError(entry, new Set(seen))));
}

// Keep diagnostic type/code chains, never arbitrary exception messages or request credentials.
export function safeTransportCause(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return undefined;
  seen.add(error);
  const name = ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'AbortError', 'AggregateError'].includes(error.name)
    ? error.name : 'Error';
  const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,50}$/u.test(error.code) ? error.code : undefined;
  const cause = safeTransportCause(error.cause, seen);
  const result = new Error(`${name}${code ? ` (${code})` : ''}${cause ? ` -> ${cause.message}` : ''}`, { cause });
  result.name = name;
  if (code) result.code = code;
  return result;
}

export function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Only read requests are retried. A POST may have reached GitHub even if its response did not.
export async function requestJson({ url, token, label, fetchImpl = globalThis.fetch, sleepImpl = sleep }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let phase = 'request';
    try {
      const response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', headers: githubHeaders(token), signal: AbortSignal.timeout(30_000),
      });
      if (!response || response.status !== 200 || response.ok !== true) {
        const error = new Error(`${label} read failed (${response?.status ?? 'invalid response'})`);
        error.status = response?.status;
        throw error;
      }
      phase = 'body';
      return await response.json();
    } catch (error) {
      const transient = isTransientTransportError(error) || TRANSIENT_HTTP_STATUSES.has(error.status);
      if (transient && attempt < 3) {
        await sleepImpl(1000 * attempt);
        continue;
      }
      const cause = safeTransportCause(error);
      const message = error.status != null ? `${label} read failed (${error.status})`
        : phase === 'body' && !transient ? `${label} returned invalid JSON`
          : `${label} ${phase === 'body' ? 'response body' : 'request'} failed`;
      throw new Error(`${message}${cause ? `: ${cause.message}` : ''}`, { cause });
    }
  }
}
