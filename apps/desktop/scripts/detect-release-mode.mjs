import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  validateMacReleaseSigning,
  validateWindowsReleaseSigning,
} from './validate-release-signing-config.mjs';

const APPLE_SIGNING_VALUES = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_TEAM_ID',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_NOTARY_API_PRIVATE_KEY',
  'APPLE_NOTARY_API_KEY_ID',
  'APPLE_NOTARY_API_ISSUER',
];

function fail(message) {
  throw new Error(`[release-mode] ${message}`);
}

export function detectReleaseMode(environment = process.env) {
  const configured = APPLE_SIGNING_VALUES.filter((name) => environment[name]?.trim()).length;
  if (configured === 0) return { mode: 'preview', production: false };
  if (configured !== APPLE_SIGNING_VALUES.length) {
    fail('Apple production signing configuration is incomplete; refusing Preview fallback');
  }
  validateMacReleaseSigning(environment);
  validateWindowsReleaseSigning(environment);
  return { mode: 'production', production: true };
}

async function main() {
  const result = detectReleaseMode();
  if (!process.env.GITHUB_OUTPUT) fail('GITHUB_OUTPUT is required in the release workflow');
  await appendFile(process.env.GITHUB_OUTPUT, `production=${result.production}\n`, { mode: 0o600 });
  process.stdout.write(result.production
    ? '[release-mode] complete cross-platform production signing configuration validated\n'
    : '[release-mode] Preview-only; GitHub Release mutation is disabled\n');
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
