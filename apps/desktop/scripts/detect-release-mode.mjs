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

const WINDOWS_SIGNING_VALUES = [
  'WINDOWS_CERTIFICATE',
  'WINDOWS_CERTIFICATE_PASSWORD',
  'WINDOWS_CERTIFICATE_THUMBPRINT',
  'WINDOWS_TIMESTAMP_URL',
  'CCEM_OFFICIAL_WINDOWS_PUBLISHER',
];

const PRODUCTION_SIGNING_VALUES = [
  ...APPLE_SIGNING_VALUES,
  ...WINDOWS_SIGNING_VALUES,
];

function fail(message) {
  throw new Error(`[release-mode] ${message}`);
}

export function detectReleaseMode(environment = process.env) {
  const configured = PRODUCTION_SIGNING_VALUES.filter((name) => environment[name]?.trim()).length;
  if (configured === 0) return { mode: 'legacy-unsigned', production: false };
  if (configured !== PRODUCTION_SIGNING_VALUES.length) {
    fail('cross-platform production signing configuration is partial; refusing unsigned fallback');
  }
  validateMacReleaseSigning(environment);
  validateWindowsReleaseSigning(environment);
  return { mode: 'production', production: true };
}

async function main() {
  const result = detectReleaseMode();
  if (!process.env.GITHUB_OUTPUT) fail('GITHUB_OUTPUT is required in the release workflow');
  await appendFile(process.env.GITHUB_OUTPUT, `mode=${result.mode}\n`, { mode: 0o600 });
  await appendFile(process.env.GITHUB_OUTPUT, `production=${result.production}\n`, { mode: 0o600 });
  process.stdout.write(result.production
    ? '[release-mode] complete cross-platform production signing configuration validated\n'
    : '[release-mode] platform signing is absent; legacy unsigned release mode selected\n');
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
