import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { CEF_FULL_VERSION } from './stage-cef-macos.mjs';
import { validateCefMacosSafeStorageBrandingEvidence } from './cef-macos-safe-storage-branding.mjs';
import { validateMacosSafeStorageReleaseSummary } from './macos-mode2-safe-storage-smoke-contract.mjs';
import { validateUpdaterReplacementReleaseSummary } from './seal-updater-replacement-release-inventory.mjs';
import {
  WINDOWS_MAIN_EXECUTABLE_NAME,
  WINDOWS_CEF_SOURCE_PIN,
  WINDOWS_SANDBOX_CLIENT_NAME,
  WINDOWS_SANDBOX_ENTRY_POINT,
} from './stage-cef-windows.mjs';
import {
  createWindowsRuntimeInventoryFingerprint,
  hashWindowsMode2SmokeJson,
  validateWindowsInstalledTreeInventory,
  validateWindowsMode2SmokeSummary,
} from './windows-mode2-production-smoke-contract.mjs';

export const RELEASE_INVENTORY_SCHEMA_VERSION = 3;
const MAX_INVENTORY_JSON_BYTES = 16 * 1024 * 1024;

export function fail(message) {
  throw new Error(`[mode2-release-inventory] ${message}`);
}

export async function pathType(candidate) {
  try {
    const stat = await fsp.lstat(candidate);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

export async function requireDirectory(candidate, label) {
  if (await pathType(candidate) !== 'directory') fail(`${label} is missing: ${candidate}`);
}

export async function requireFile(candidate, label) {
  if (await pathType(candidate) !== 'file') fail(`${label} is missing: ${candidate}`);
}

export async function readJsonWithSha256(candidate, label) {
  const exact = path.resolve(candidate);
  const pathMetadata = await fsp.lstat(exact).catch((error) => {
    fail(`${label} is missing: ${error.message}`);
  });
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    fail(`${label} must be a regular non-link file`);
  }
  const handle = await fsp.open(exact, 'r');
  try {
    const handleMetadata = await handle.stat();
    if (
      !handleMetadata.isFile()
      || handleMetadata.size > MAX_INVENTORY_JSON_BYTES
      || pathMetadata.dev !== handleMetadata.dev
      || pathMetadata.ino !== handleMetadata.ino
    ) {
      fail(`${label} changed identity or exceeds the JSON size bound`);
    }
    const bytes = await handle.readFile();
    const finalMetadata = await handle.stat();
    if (bytes.length !== handleMetadata.size || finalMetadata.size !== handleMetadata.size) {
      fail(`${label} changed while it was being consumed`);
    }
    return {
      value: JSON.parse(bytes.toString('utf8')),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if (String(error.message).startsWith('[mode2-release-inventory]')) throw error;
    fail(`${label} is not valid JSON: ${error.message}`);
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function readJson(candidate, label) {
  return (await readJsonWithSha256(candidate, label)).value;
}

export async function sha256(candidate) {
  const hash = createHash('sha256');
  const handle = await fsp.open(candidate, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

export function validateSourceCommit(value) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? '')) {
    fail('source commit must be an exact 40-character Git SHA');
  }
  return value;
}

export function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function fingerprintFiles(root, relatives) {
  const result = {};
  for (const relative of relatives) {
    const candidate = path.join(root, ...relative.split('/'));
    await requireFile(candidate, relative);
    result[relative] = await sha256(candidate);
  }
  return result;
}

function validateArtifactRecord(record, label) {
  if (
    !record
    || typeof record.fileName !== 'string'
    || path.basename(record.fileName) !== record.fileName
    || ['.', '..'].includes(record.fileName)
    || record.fileName === 'latest.json'
    || /[\u0000-\u001f\u007f]/u.test(record.fileName)
    || !/^[a-f0-9]{64}$/u.test(record.sha256 ?? '')
    || !Number.isSafeInteger(record.size)
    || record.size <= 0
  ) {
    fail(`${label} must bind an exact basename, SHA-256, and positive byte size`);
  }
}

export function validateInventoryFileBindings(inventoryFiles, inventories) {
  if (inventoryFiles.length !== inventories.length) fail('inventory file/value count mismatch');
  const actualNames = inventoryFiles.map((candidate) => path.basename(candidate));
  if (new Set(actualNames).size !== actualNames.length) {
    fail('release inventory basenames must be unique');
  }
  inventories.forEach((inventory, index) => {
    const expected = `mode2-release-inventory-${inventory.platform}.json`;
    if (actualNames[index] !== expected) {
      fail(`inventory basename ${actualNames[index]} does not match target ${inventory.platform}`);
    }
  });
}

export function validateInventorySetWithPolicy(
  inventories,
  expectedVersion,
  expectedSourceCommit,
  windowsMode2ReleaseBlockReason,
) {
  validateSourceCommit(expectedSourceCommit);
  if (inventories.length !== 3) {
    fail(`release inventory set must contain exactly 3 targets; found ${inventories.length}`);
  }
  const platforms = inventories.map(({ platform }) => platform).sort();
  const expectedPlatforms = [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
  ].sort();
  if (!sameJson(platforms, expectedPlatforms)) {
    fail(`release target inventory mismatch: ${platforms.join(', ')}`);
  }
  const artifactNames = new Set();
  for (const inventory of inventories) {
    if (
      inventory.schemaVersion !== RELEASE_INVENTORY_SCHEMA_VERSION
      || inventory.appVersion !== expectedVersion
    ) {
      fail(`${inventory.platform} inventory app version does not equal ${expectedVersion}`);
    }
    if (inventory.sourceCommit !== expectedSourceCommit) {
      fail(`${inventory.platform} inventory source commit does not equal ${expectedSourceCommit}`);
    }
    if (inventory.mode2Included !== true) {
      fail(`${inventory.platform} is preview-only and cannot enter the production updater aggregate`);
    }
    if (inventory.cefRuntimeVersion !== CEF_FULL_VERSION) {
      fail(`${inventory.platform} contains a mixed or unpinned CEF runtime`);
    }
    if (inventory.updaterSignatureVerification !== 'minisign-ed25519-blake2b') {
      fail(`${inventory.platform} updater signature lacks cryptographic verification`);
    }
    const expectedArtifactRoles = inventory.platform.endsWith('apple-darwin')
      ? ['dmg', 'updater', 'updaterSignature']
      : ['updater', 'updaterSignature'];
    if (!sameJson(Object.keys(inventory.artifacts ?? {}).sort(), expectedArtifactRoles)) {
      fail(`${inventory.platform} inventory must contain exactly the expected release artifact roles`);
    }
    validateArtifactRecord(inventory.artifacts?.updater, `${inventory.platform} updater`);
    validateArtifactRecord(
      inventory.artifacts?.updaterSignature,
      `${inventory.platform} updater signature`,
    );
    if (
      inventory.artifacts.updaterSignature.fileName
      !== `${inventory.artifacts.updater.fileName}.sig`
    ) {
      fail(`${inventory.platform} updater signature basename does not bind its updater artifact`);
    }
    if (inventory.platform.endsWith('apple-darwin')) {
      validateArtifactRecord(inventory.artifacts?.dmg, `${inventory.platform} DMG`);
      validateArtifactRecord(inventory.mainExecutable, `${inventory.platform} main executable`);
      const {
        signedExecutableSha256,
        ...safeStorageBranding
      } = inventory.cefSafeStorageBranding ?? {};
      validateCefMacosSafeStorageBrandingEvidence(safeStorageBranding);
      if (!/^[a-f0-9]{64}$/u.test(signedExecutableSha256 ?? '')) {
        fail(`${inventory.platform} lacks the signed CCEM Safe Storage branded framework digest`);
      }
      validateMacosSafeStorageReleaseSummary(
        inventory.macosSafeStorageRuntimeAttestation,
        {
          target: inventory.platform,
          sourceCommit: expectedSourceCommit,
          appVersion: expectedVersion,
          executableSha256: inventory.mainExecutable?.sha256,
          frameworkSha256: signedExecutableSha256,
        },
      );
      if (
        inventory.platformVerification !== 'macos-native-release-trust'
        || inventory.dmgNotarization?.status !== 'Accepted'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu
          .test(inventory.dmgNotarization?.id ?? '')
      ) {
        fail(`${inventory.platform} lacks final native app/DMG trust verification`);
      }
    }
    if (inventory.platform.endsWith('pc-windows-msvc')) {
      const installedTree = validateWindowsInstalledTreeInventory(
        inventory.installedTree,
        `${inventory.platform} installed tree`,
      );
      if (
        !sameJson(inventory.cefSourcePin, WINDOWS_CEF_SOURCE_PIN)
        || inventory.sandboxEnabled !== true
        || inventory.sameExecutableSubprocesses !== true
        || inventory.sandboxBootstrapExecutable !== WINDOWS_MAIN_EXECUTABLE_NAME
        || inventory.sandboxClientLibrary !== WINDOWS_SANDBOX_CLIENT_NAME
        || inventory.sandboxEntryPoint !== WINDOWS_SANDBOX_ENTRY_POINT
      ) {
        fail(windowsMode2ReleaseBlockReason);
      }
      if (inventory.platformVerification !== 'windows-native-authenticode-installed-runtime-smoke') {
        fail(`${inventory.platform} lacks installed runtime verification`);
      }
      const smoke = validateWindowsMode2SmokeSummary(inventory.windowsRuntimeAttestation, {
        sourceCommit: expectedSourceCommit,
        appVersion: expectedVersion,
        installedTreeInventorySha256: installedTree.inventorySha256,
        installedTreePathSetSha256: installedTree.pathSetSha256,
        installedTreePathCount: installedTree.pathCount,
      });
      const runtimeFingerprint = createWindowsRuntimeInventoryFingerprint({
        installedExecutableSha256: inventory.mainExecutable?.sha256,
        stableCefResources: inventory.stableCefResources,
      });
      if (
        smoke.installedExecutableSha256 !== inventory.mainExecutable?.sha256
        || smoke.installerSha256 !== inventory.artifacts.updater.sha256
        || smoke.runtimeInventorySha256 !== runtimeFingerprint.sha256
        || smoke.verifiedPathCount !== runtimeFingerprint.verifiedPathCount
        || smoke.verifiedPathsSha256 !== hashWindowsMode2SmokeJson(runtimeFingerprint.relativePaths)
        || smoke.installedTreeInventorySha256 !== installedTree.inventorySha256
        || smoke.installedTreePathSetSha256 !== installedTree.pathSetSha256
        || smoke.installedTreePathCount !== installedTree.pathCount
      ) {
        fail(`${inventory.platform} runtime smoke does not bind the published installer and runtime`);
      }
    }
    const runtimeAttestation = inventory.platform.endsWith('apple-darwin')
      ? inventory.macosSafeStorageRuntimeAttestation
      : inventory.windowsRuntimeAttestation;
    validateUpdaterReplacementReleaseSummary(
      inventory.updaterReplacementAttestation,
      {
        target: inventory.platform,
        sourceCommit: expectedSourceCommit,
        appVersion: expectedVersion,
        currentExecutableSha256: inventory.mainExecutable?.sha256,
        updaterArtifactSha256: inventory.artifacts.updater.sha256,
        updaterSignatureSha256: inventory.artifacts.updaterSignature.sha256,
        installedTree: inventory.installedTree,
        runId: runtimeAttestation?.runId,
        runAttempt: runtimeAttestation?.runAttempt,
        repository: runtimeAttestation?.repository,
        workflowRef: runtimeAttestation?.workflowRef,
        producerWorkflowRef: runtimeAttestation?.producerWorkflowRef,
        job: runtimeAttestation?.job,
      },
    );
    for (const record of Object.values(inventory.artifacts)) {
      if (artifactNames.has(record.fileName)) {
        fail(`duplicate release artifact basename: ${record.fileName}`);
      }
      artifactNames.add(record.fileName);
    }
  }
  return {
    schemaVersion: RELEASE_INVENTORY_SCHEMA_VERSION,
    appVersion: expectedVersion,
    sourceCommit: expectedSourceCommit,
    cefRuntimeVersion: CEF_FULL_VERSION,
    targets: inventories.map(({ platform, mode2Included, artifacts }) => ({
      platform,
      mode2Included,
      artifacts,
    })),
  };
}
