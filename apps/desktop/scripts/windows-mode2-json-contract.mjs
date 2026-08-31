import { createHash } from 'node:crypto';

function fail(message) {
  throw new Error(`[windows-mode2-smoke] ${message}`);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('smoke evidence contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  fail('smoke evidence contains a non-JSON value');
}

export function hashWindowsMode2SmokeJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
