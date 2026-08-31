import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  WINDOWS_MAIN_EXECUTABLE_NAME,
  WINDOWS_SANDBOX_CLIENT_NAME,
  WINDOWS_SANDBOX_MARKER_NAME,
  WINDOWS_SOURCE_BOOTSTRAP_NAME,
  WINDOWS_STAGE_MANIFEST,
  WINDOWS_TARGET,
  WINDOWS_CEF_SOURCE_PIN,
  validateWindowsSandboxMarker,
} from './stage-cef-windows.mjs';
import { assertPeX64, canonicalPeSha256 } from './windows-pe-contract.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = path.resolve(path.dirname(scriptPath), '..');
const tauriDir = path.join(desktopDir, 'src-tauri');

function fail(message) {
  throw new Error(`[cef-windows-activate] ${message}`);
}

async function requireFile(candidate, label) {
  let stat;
  try {
    stat = await fsp.lstat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} is missing: ${candidate}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file: ${candidate}`);
}

async function readJson(candidate, label) {
  await requireFile(candidate, label);
  try {
    return JSON.parse(await fsp.readFile(candidate, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
}

export async function activateWindowsBootstrap({
  stageDir,
  targetExecutable,
  gitSha,
  expectedSourcePin = WINDOWS_CEF_SOURCE_PIN,
}) {
  if (!/^[a-f0-9]{40}$/u.test(gitSha ?? '')) fail('gitSha must be an exact commit SHA');
  const bootstrapPath = path.join(stageDir, WINDOWS_SOURCE_BOOTSTRAP_NAME);
  const clientPath = path.join(stageDir, WINDOWS_SANDBOX_CLIENT_NAME);
  const markerPath = path.join(stageDir, WINDOWS_SANDBOX_MARKER_NAME);
  const manifestPath = path.join(stageDir, WINDOWS_STAGE_MANIFEST);
  for (const [candidate, label] of [
    [bootstrapPath, 'official CEF bootstrap'],
    [clientPath, 'CEF sandbox client DLL'],
    [targetExecutable, 'Cargo-built Tauri executable'],
  ]) await requireFile(candidate, label);

  const bootstrap = await fsp.readFile(bootstrapPath);
  const client = await fsp.readFile(clientPath);
  const cargoExecutable = await fsp.readFile(targetExecutable);
  const bootstrapPe = assertPeX64(bootstrap, 'official CEF bootstrap');
  assertPeX64(client, 'CEF sandbox client DLL');
  assertPeX64(cargoExecutable, 'Cargo-built Tauri executable');
  if (bootstrapPe.certificateSize !== 0) {
    fail('official CEF bootstrap must remain unsigned until Tauri signs the final main executable');
  }

  const marker = validateWindowsSandboxMarker(
    await readJson(markerPath, 'Windows sandbox artifact marker'),
    {
      expectedGitSha: gitSha,
      expectedSourcePin,
      bootstrapCanonicalSha256: canonicalPeSha256(bootstrap),
      clientCanonicalSha256: canonicalPeSha256(client),
    },
  );
  const manifest = await readJson(manifestPath, 'Windows CEF staging manifest');
  if (
    manifest.schemaVersion !== 4
    || manifest.target !== WINDOWS_TARGET
    || manifest.profile !== 'release'
    || manifest.sourceCommit !== gitSha
    || JSON.stringify(manifest.sourcePin) !== JSON.stringify(expectedSourcePin)
    || JSON.stringify(manifest.sandbox) !== JSON.stringify(marker)
  ) {
    fail('Windows CEF staging manifest does not bind the current sandbox producer output');
  }

  const temporary = `${targetExecutable}.bootstrap-${process.pid}-${randomBytes(4).toString('hex')}`;
  const backup = `${targetExecutable}.cargo-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fsp.copyFile(bootstrapPath, temporary);
  try {
    if (canonicalPeSha256(await fsp.readFile(temporary)) !== marker.bootstrapCanonicalSha256) {
      fail('copied CEF bootstrap canonical hash changed before activation');
    }
    await fsp.rename(targetExecutable, backup);
    try {
      await fsp.rename(temporary, targetExecutable);
    } catch (error) {
      await fsp.rename(backup, targetExecutable);
      throw error;
    }
    await fsp.rm(backup, { force: true });
  } finally {
    await fsp.rm(temporary, { force: true });
  }

  return {
    targetExecutable,
    bootstrapCanonicalSha256: marker.bootstrapCanonicalSha256,
    clientCanonicalSha256: marker.clientCanonicalSha256,
  };
}

export async function run(environment = process.env) {
  const target = environment.CCEM_CEF_TARGET_TRIPLE?.trim();
  if (target !== WINDOWS_TARGET) fail(`CCEM_CEF_TARGET_TRIPLE must equal ${WINDOWS_TARGET}`);
  const gitSha = environment.GITHUB_SHA?.trim();
  const stageDir = path.join(tauriDir, 'target', 'cef-bundle', 'windows');
  const targetExecutable = path.join(
    tauriDir,
    'target',
    WINDOWS_TARGET,
    'release',
    WINDOWS_MAIN_EXECUTABLE_NAME,
  );
  const result = await activateWindowsBootstrap({ stageDir, targetExecutable, gitSha });
  process.stdout.write(`[cef-windows-activate] activated ${result.targetExecutable}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
