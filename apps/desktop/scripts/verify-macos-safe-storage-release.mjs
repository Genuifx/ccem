import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV,
  createMacosSafeStorageReleaseSummary,
  createMacosSafeStorageSmokePlan,
  validateMacosSafeStorageReleaseSummary,
} from './macos-mode2-safe-storage-smoke-contract.mjs';

const MAX_ATTESTATION_BYTES = 8 * 1024 * 1024;

function fail(message) {
  throw new Error(`[macos-safe-storage-release] ${message}`);
}

async function readPrivateCurrentUserFile(candidate) {
  const resolved = path.resolve(candidate);
  let metadata;
  try {
    metadata = await fsp.lstat(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`attestation is missing: ${resolved}`);
    throw error;
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size <= 0
    || metadata.size > MAX_ATTESTATION_BYTES
    || (metadata.mode & 0o077) !== 0
    || (typeof process.geteuid === 'function' && metadata.uid !== process.geteuid())
    || await fsp.realpath(resolved) !== resolved
  ) {
    fail('attestation must be a private, real, current-user file within the exact smoke root');
  }
  return fsp.readFile(resolved);
}

export async function inspectMacosSafeStorageReleaseAttestation({
  attestationPath,
  appDir,
  target,
  appVersion,
  sourceCommit,
  executableSha256,
  frameworkSha256,
  environment = process.env,
}) {
  const configuredAttestation = environment[MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV];
  if (!configuredAttestation || path.resolve(configuredAttestation) !== path.resolve(attestationPath)) {
    fail('attestation path is not the explicit current-run Safe Storage output');
  }
  const plan = createMacosSafeStorageSmokePlan({ environment, sourceApp: path.resolve(appDir) });
  if (
    path.resolve(attestationPath) !== path.resolve(plan.paths.attestationPath)
    || plan.sourceCommit !== sourceCommit
  ) {
    fail('attestation path or source commit is not bound to this release job');
  }
  const bytes = await readPrivateCurrentUserFile(attestationPath);
  let attestation;
  try {
    attestation = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`attestation is invalid JSON: ${error.message}`);
  }
  const summary = createMacosSafeStorageReleaseSummary(attestation, plan, {
    target,
    appVersion,
    attestationSha256: createHash('sha256').update(bytes).digest('hex'),
    executableSha256,
    frameworkSha256,
  });
  return validateMacosSafeStorageReleaseSummary(summary, {
    target,
    sourceCommit,
    appVersion,
    executableSha256,
    frameworkSha256,
  });
}
