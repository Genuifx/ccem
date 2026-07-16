import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateInventorySet } from './verify-mode2-release-inventory.mjs';

export const RELEASE_TARGETS = Object.freeze([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
]);

const TARGET_ROLES = Object.freeze({
  'aarch64-apple-darwin': ['dmg', 'updater', 'updaterSignature'],
  'x86_64-apple-darwin': ['dmg', 'updater', 'updaterSignature'],
  'x86_64-pc-windows-msvc': ['updater', 'updaterSignature'],
});

function fail(message) {
  throw new Error(`[verify-release-payloads] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

function sameSet(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function validateRunId(value) {
  const exact = required(value, 'GitHub run id');
  if (!/^[1-9][0-9]*$/u.test(exact)) fail('GitHub run id must be a positive decimal string');
  return exact;
}

function validateRunAttempt(value) {
  const exact = required(value, 'GitHub run attempt');
  if (!/^[1-9][0-9]*$/u.test(exact)) fail('GitHub run attempt must be a positive decimal string');
  return exact;
}

function validateSourceCommit(value) {
  const exact = required(value, 'source commit');
  if (!/^[a-f0-9]{40}$/u.test(exact)) fail('source commit must be a lowercase 40-character SHA');
  return exact;
}

async function readJsonFile(candidate, label) {
  const exact = path.resolve(candidate);
  const stat = await fsp.lstat(exact).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  try {
    return JSON.parse(await fsp.readFile(exact, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

async function requireExactDirectory(candidate, label) {
  const stat = await fsp.lstat(candidate).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink directory`);
}

async function exactEntries(directory, expected, label) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const names = entries.map(({ name }) => name);
  if (!sameSet(names, expected) || names.length !== expected.length) {
    fail(`${label} must contain exactly: ${expected.join(', ')}`);
  }
  return entries;
}

async function fingerprint(candidate, label) {
  const stat = await fsp.lstat(candidate).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  const hash = createHash('sha256');
  const handle = await fsp.open(candidate, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return { size: stat.size, sha256: hash.digest('hex') };
}

function validateManifestAsset(record, inventoryArtifact, role) {
  if (
    !record
    || record.fileName !== inventoryArtifact?.fileName
    || record.relativePath !== `assets/${record.fileName}`
    || typeof record.contentType !== 'string'
    || record.contentType.trim() === ''
    || record.size !== inventoryArtifact?.size
    || record.sha256 !== inventoryArtifact?.sha256
  ) {
    fail(`${role} payload manifest does not bind the final inventory artifact`);
  }
}

async function writeJsonAtomically(candidate, value) {
  const output = path.resolve(required(candidate, 'output path'));
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, output);
}

export async function verifyReleasePayloads({
  payloadRoot,
  version,
  sourceCommit,
  tag,
  runId,
  runAttempt,
  inventoryOutput,
  contractOutput,
}) {
  const root = path.resolve(required(payloadRoot, 'payload root'));
  const exactVersion = required(version, 'release version');
  const exactSourceCommit = validateSourceCommit(sourceCommit);
  const exactTag = required(tag, 'release tag');
  const exactRunId = validateRunId(runId);
  const exactRunAttempt = validateRunAttempt(runAttempt);
  await requireExactDirectory(root, 'payload root');

  const artifactDirectories = RELEASE_TARGETS.map(
    (target) => `mode2-release-payload-${exactRunId}-${exactRunAttempt}-${target}`,
  );
  await exactEntries(root, artifactDirectories, 'downloaded payload root');
  const inventories = [];
  const contractTargets = [];

  for (const target of RELEASE_TARGETS) {
    const artifactName = `mode2-release-payload-${exactRunId}-${exactRunAttempt}-${target}`;
    const artifactRoot = path.join(root, artifactName);
    await requireExactDirectory(artifactRoot, `${target} payload`);
    await exactEntries(artifactRoot, ['assets', 'inventory.json', 'payload-manifest.json'], `${target} payload`);
    const assetsRoot = path.join(artifactRoot, 'assets');
    await requireExactDirectory(assetsRoot, `${target} payload assets`);
    const manifest = await readJsonFile(path.join(artifactRoot, 'payload-manifest.json'), `${target} payload manifest`);
    const inventory = await readJsonFile(path.join(artifactRoot, 'inventory.json'), `${target} inventory`);
    const expectedRoles = TARGET_ROLES[target];
    if (
      manifest?.schemaVersion !== 1
      || manifest.runId !== exactRunId
      || manifest.runAttempt !== exactRunAttempt
      || manifest.tag !== exactTag
      || manifest.target !== target
      || manifest.sourceCommit !== exactSourceCommit
      || manifest.appVersion !== exactVersion
      || inventory?.platform !== target
      || inventory.sourceCommit !== exactSourceCommit
      || inventory.appVersion !== exactVersion
      || inventory.updaterReplacementAttestation?.runId !== exactRunId
      || !sameSet(Object.keys(manifest.assets ?? {}), expectedRoles)
      || !sameSet(Object.keys(inventory.artifacts ?? {}), expectedRoles)
    ) {
      fail(`${target} payload does not bind the current run, tag, version, source, and target`);
    }
    const expectedAssetNames = expectedRoles.map((role) => manifest.assets[role]?.fileName);
    if (expectedAssetNames.some((name) => typeof name !== 'string') || new Set(expectedAssetNames).size !== expectedRoles.length) {
      fail(`${target} payload contains invalid or duplicate asset names`);
    }
    const assetEntries = await exactEntries(assetsRoot, expectedAssetNames, `${target} payload assets`);
    if (assetEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      fail(`${target} payload assets must all be regular files`);
    }
    const contractAssets = {};
    for (const role of expectedRoles) {
      const record = manifest.assets[role];
      validateManifestAsset(record, inventory.artifacts[role], `${target} ${role}`);
      const assetPath = path.join(assetsRoot, record.fileName);
      const actual = await fingerprint(assetPath, `${target} ${role}`);
      if (actual.size !== record.size || actual.sha256 !== record.sha256) {
        fail(`${target} ${role} payload bytes do not match its immutable manifest`);
      }
      contractAssets[role] = { ...record, path: assetPath };
    }
    inventories.push(inventory);
    contractTargets.push({ target, assets: contractAssets });
  }

  const aggregateInventory = validateInventorySet(inventories, exactVersion, exactSourceCommit);
  const contract = {
    schemaVersion: 1,
    runId: exactRunId,
    runAttempt: exactRunAttempt,
    tag: exactTag,
    sourceCommit: exactSourceCommit,
    appVersion: exactVersion,
    targets: contractTargets,
  };
  await writeJsonAtomically(inventoryOutput, aggregateInventory);
  await writeJsonAtomically(contractOutput, contract);
  return { aggregateInventory, contract };
}

function parseArgs(argv) {
  const values = {};
  const options = new Map([
    ['--payload-root', 'payloadRoot'],
    ['--version', 'version'],
    ['--source-commit', 'sourceCommit'],
    ['--tag', 'tag'],
    ['--run-id', 'runId'],
    ['--run-attempt', 'runAttempt'],
    ['--inventory-output', 'inventoryOutput'],
    ['--contract-output', 'contractOutput'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = options.get(argv[index]);
    if (!key || index + 1 >= argv.length) fail(`invalid argument: ${argv[index] ?? '<missing>'}`);
    values[key] = argv[index + 1];
  }
  return values;
}

async function main() {
  const result = await verifyReleasePayloads(parseArgs(process.argv.slice(2)));
  process.stdout.write(`[verify-release-payloads] ${result.contract.targets.length} immutable target payloads verified\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
