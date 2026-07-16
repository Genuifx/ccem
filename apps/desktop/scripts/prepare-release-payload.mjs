import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { discoverTargetAssets } from './upload-draft-release-assets.mjs';

const TARGET_ROLES = Object.freeze({
  'aarch64-apple-darwin': ['dmg', 'updater', 'updaterSignature'],
  'x86_64-apple-darwin': ['dmg', 'updater', 'updaterSignature'],
  'x86_64-pc-windows-msvc': ['updater', 'updaterSignature'],
});

function fail(message) {
  throw new Error(`[prepare-release-payload] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

function validateRunId(value) {
  const runId = required(value, 'GitHub run id');
  if (!/^[1-9][0-9]*$/u.test(runId)) fail('GitHub run id must be a positive decimal string');
  return runId;
}

function validateSourceCommit(value) {
  const sourceCommit = required(value, 'source commit');
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) fail('source commit must be a lowercase 40-character SHA');
  return sourceCommit;
}

async function readJsonFile(candidate, label) {
  const exact = path.resolve(required(candidate, `${label} path`));
  const stat = await fsp.lstat(exact).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  try {
    return { path: exact, value: JSON.parse(await fsp.readFile(exact, 'utf8')) };
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

async function fileFingerprint(candidate) {
  const exact = path.resolve(candidate);
  const stat = await fsp.lstat(exact).catch((error) => fail(`release asset is missing: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) fail('release assets must be regular non-symlink files');
  const hash = createHash('sha256');
  const handle = await fsp.open(exact, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return { size: stat.size, sha256: hash.digest('hex') };
}

function sameSet(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
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

export async function prepareReleasePayload({
  desktopDir,
  inventoryPath,
  outputDir,
  target,
  runId,
  tag,
  sourceCommit,
}) {
  const exactTarget = required(target, 'release target');
  const expectedRoles = TARGET_ROLES[exactTarget];
  if (!expectedRoles) fail(`unsupported release target: ${exactTarget}`);
  const exactRunId = validateRunId(runId);
  const exactTag = required(tag, 'release tag');
  const exactSourceCommit = validateSourceCommit(sourceCommit);
  const inventoryRecord = await readJsonFile(inventoryPath, 'release inventory');
  const inventory = inventoryRecord.value;
  if (
    inventory?.platform !== exactTarget
    || inventory.sourceCommit !== exactSourceCommit
    || inventory.mode2Included !== true
  ) {
    fail('release inventory does not bind the exact production target and source commit');
  }
  if (!sameSet(Object.keys(inventory.artifacts ?? {}), expectedRoles)) {
    fail(`${exactTarget} inventory has an invalid release artifact role set`);
  }
  for (const role of expectedRoles) validateArtifact(inventory.artifacts[role], `${exactTarget} ${role}`);

  const discovered = await discoverTargetAssets(path.resolve(desktopDir), exactTarget);
  const discoveredByName = new Map(discovered.map((candidate) => [candidate.fileName, candidate]));
  if (discoveredByName.size !== expectedRoles.length) fail('bundle discovery returned an invalid asset set');

  const destination = path.resolve(required(outputDir, 'payload output directory'));
  const parent = path.dirname(destination);
  await fsp.mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(destination)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  await fsp.rm(temporary, { recursive: true, force: true });
  await fsp.mkdir(path.join(temporary, 'assets'), { recursive: true, mode: 0o700 });

  try {
    const assets = {};
    for (const role of expectedRoles) {
      const artifact = inventory.artifacts[role];
      const candidate = discoveredByName.get(artifact.fileName);
      if (!candidate || candidate.sha256 !== artifact.sha256 || candidate.size !== artifact.size) {
        fail(`${exactTarget} ${role} bundle bytes do not match the final native inventory`);
      }
      const destinationAsset = path.join(temporary, 'assets', artifact.fileName);
      await fsp.copyFile(candidate.path, destinationAsset, fsp.constants.COPYFILE_EXCL);
      const copied = await fileFingerprint(destinationAsset);
      if (copied.sha256 !== artifact.sha256 || copied.size !== artifact.size) {
        fail(`${exactTarget} ${role} changed while creating the immutable payload`);
      }
      assets[role] = {
        fileName: artifact.fileName,
        relativePath: `assets/${artifact.fileName}`,
        contentType: candidate.contentType,
        size: artifact.size,
        sha256: artifact.sha256,
      };
    }

    await fsp.copyFile(inventoryRecord.path, path.join(temporary, 'inventory.json'), fsp.constants.COPYFILE_EXCL);
    const manifest = {
      schemaVersion: 1,
      runId: exactRunId,
      tag: exactTag,
      target: exactTarget,
      sourceCommit: exactSourceCommit,
      appVersion: inventory.appVersion,
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

function parseArgs(argv) {
  const values = {};
  const options = new Map([
    ['--target', 'target'],
    ['--inventory', 'inventoryPath'],
    ['--output', 'outputDir'],
    ['--run-id', 'runId'],
    ['--tag', 'tag'],
    ['--source-commit', 'sourceCommit'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = options.get(argv[index]);
    if (!key || index + 1 >= argv.length) fail(`invalid argument: ${argv[index] ?? '<missing>'}`);
    values[key] = argv[index + 1];
  }
  return values;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await prepareReleasePayload({ ...options, desktopDir: process.cwd() });
  process.stdout.write(`[prepare-release-payload] ${manifest.target}: immutable payload ready\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
