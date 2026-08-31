import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  discoverTargetAssets,
  fingerprintReleaseFile,
  requireRegularReleaseFile,
} from './release-asset-discovery.mjs';

const TARGET_INVENTORY_ROLES = Object.freeze({
  'aarch64-apple-darwin': Object.freeze(['dmg', 'updater', 'updaterSignature']),
  'x86_64-apple-darwin': Object.freeze(['dmg', 'updater', 'updaterSignature']),
  'x86_64-pc-windows-msvc': Object.freeze(['updater', 'updaterSignature']),
});
const PAYLOAD_ROLES = Object.freeze(['updater', 'updaterSignature']);

function fail(message) {
  throw new Error(`[prepare-updater-replacement-payload] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

function validateSourceCommit(value) {
  const sourceCommit = required(value, 'source commit');
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    fail('source commit must be a lowercase 40-character SHA');
  }
  return sourceCommit;
}

function sameSet(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

async function readJsonFile(candidate, label) {
  const exact = path.resolve(required(candidate, `${label} path`));
  await requireRegularReleaseFile(exact, label);
  try {
    return { path: exact, value: JSON.parse(await fsp.readFile(exact, 'utf8')) };
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateArtifact(record, label) {
  if (
    !record
    || typeof record.fileName !== 'string'
    || path.basename(record.fileName) !== record.fileName
    || ['.', '..', 'latest.json'].includes(record.fileName)
    || /[\u0000-\u001f\u007f]/u.test(record.fileName)
    || !Number.isSafeInteger(record.size)
    || record.size <= 0
    || !/^[a-f0-9]{64}$/u.test(record.sha256 ?? '')
  ) {
    fail(`${label} must bind an exact basename, SHA-256, and positive byte size`);
  }
}

function validateInventory(inventory, target, sourceCommit, expectedRoles) {
  const appVersion = required(inventory?.appVersion, 'release inventory app version');
  if (
    inventory?.platform !== target
    || inventory.sourceCommit !== sourceCommit
    || inventory.appVersion !== appVersion
    || inventory.mode2Included !== true
  ) {
    fail('release inventory does not bind the exact production target and source commit');
  }
  if (!sameSet(Object.keys(inventory.artifacts ?? {}), expectedRoles)) {
    fail(`${target} inventory has an invalid release artifact role set`);
  }
  for (const role of expectedRoles) {
    validateArtifact(inventory.artifacts[role], `${target} ${role}`);
  }
  if (
    inventory.artifacts.updaterSignature.fileName
    !== `${inventory.artifacts.updater.fileName}.sig`
  ) {
    fail(`${target} updater signature basename does not match the updater`);
  }
  return appVersion;
}

export async function prepareUpdaterReplacementPayload({
  desktopDir,
  inventoryPath,
  outputDir,
  target,
  sourceCommit,
}) {
  const exactTarget = required(target, 'release target');
  const expectedRoles = TARGET_INVENTORY_ROLES[exactTarget];
  if (!expectedRoles) fail(`unsupported release target: ${exactTarget}`);
  const exactSourceCommit = validateSourceCommit(sourceCommit);
  const inventoryRecord = await readJsonFile(inventoryPath, 'release inventory');
  const inventory = inventoryRecord.value;
  const appVersion = validateInventory(
    inventory,
    exactTarget,
    exactSourceCommit,
    expectedRoles,
  );

  const discovered = await discoverTargetAssets(path.resolve(desktopDir), exactTarget);
  const discoveredByName = new Map(discovered.map((candidate) => [candidate.fileName, candidate]));
  if (discoveredByName.size !== expectedRoles.length) {
    fail('bundle discovery returned an invalid asset set');
  }
  const candidates = {};
  for (const role of expectedRoles) {
    const artifact = inventory.artifacts[role];
    const candidate = discoveredByName.get(artifact.fileName);
    if (!candidate || candidate.sha256 !== artifact.sha256 || candidate.size !== artifact.size) {
      fail(`${exactTarget} ${role} bundle bytes do not match the final native inventory`);
    }
    candidates[role] = candidate;
  }

  const destination = path.resolve(required(outputDir, 'payload output directory'));
  const parent = path.dirname(destination);
  await fsp.mkdir(parent, { recursive: true });
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  await fsp.rm(temporary, { recursive: true, force: true });
  await fsp.mkdir(path.join(temporary, 'assets'), { recursive: true, mode: 0o700 });

  try {
    const assets = {};
    for (const role of PAYLOAD_ROLES) {
      const artifact = inventory.artifacts[role];
      const candidate = candidates[role];
      const destinationAsset = path.join(temporary, 'assets', artifact.fileName);
      await fsp.copyFile(candidate.path, destinationAsset, fsp.constants.COPYFILE_EXCL);
      const copied = await fingerprintReleaseFile(destinationAsset, `${exactTarget} ${role}`);
      if (copied.sha256 !== artifact.sha256 || copied.size !== artifact.size) {
        fail(`${exactTarget} ${role} changed while creating the challenge payload`);
      }
      assets[role] = {
        fileName: artifact.fileName,
        relativePath: `assets/${artifact.fileName}`,
        contentType: candidate.contentType,
        size: artifact.size,
        sha256: artifact.sha256,
      };
    }

    const copiedInventoryPath = path.join(temporary, 'inventory.json');
    await fsp.copyFile(
      inventoryRecord.path,
      copiedInventoryPath,
      fsp.constants.COPYFILE_EXCL,
    );
    const copiedInventory = (await readJsonFile(
      copiedInventoryPath,
      'copied release inventory',
    )).value;
    if (JSON.stringify(copiedInventory) !== JSON.stringify(inventory)) {
      fail('release inventory changed while creating the challenge payload');
    }

    const manifest = {
      schemaVersion: 1,
      target: exactTarget,
      sourceCommit: exactSourceCommit,
      appVersion,
      assets,
    };
    await fsp.writeFile(
      path.join(temporary, 'payload-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.rename(temporary, destination);
    return manifest;
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const values = {};
  const options = new Map([
    ['--target', 'target'],
    ['--inventory', 'inventoryPath'],
    ['--output', 'outputDir'],
    ['--source-commit', 'sourceCommit'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = options.get(argv[index]);
    if (!key || index + 1 >= argv.length || Object.hasOwn(values, key)) {
      fail(`invalid argument: ${argv[index] ?? '<missing>'}`);
    }
    values[key] = argv[index + 1];
  }
  if (Object.keys(values).length !== options.size) {
    fail('target, inventory, output, and source commit are required');
  }
  return values;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = await prepareUpdaterReplacementPayload({
    ...options,
    desktopDir: process.cwd(),
  });
  process.stdout.write(
    `[prepare-updater-replacement-payload] ${manifest.target}: challenge payload ready\n`,
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
