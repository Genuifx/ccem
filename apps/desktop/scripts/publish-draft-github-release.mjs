import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { DraftReleaseClient, exactAssetsNamed } from './github-draft-release-api.mjs';
import { verifyImmutableReleasesEnabled } from './verify-immutable-releases-enabled.mjs';

const TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
];

function fail(message) {
  throw new Error(`[publish-draft-github-release] ${message}`);
}

function sameNames(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

async function readJson(candidate, label) {
  if (typeof candidate !== 'string' || candidate.trim() === '') fail(`${label} path is required`);
  const exact = path.resolve(candidate);
  const stat = await fsp.lstat(exact).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  try {
    return JSON.parse(await fsp.readFile(exact, 'utf8'));
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
    || !/^[a-f0-9]{64}$/u.test(record.sha256 ?? '')
    || !Number.isSafeInteger(record.size)
    || record.size <= 0
  ) {
    fail(`${label} must bind an exact release basename, SHA-256, and byte size`);
  }
}

function validateReceiptRecord(record, artifact, label) {
  if (
    !Number.isSafeInteger(record?.assetId)
    || record.assetId <= 0
    || record.sha256 !== artifact.sha256
    || record.size !== artifact.size
  ) {
    fail(`${label} does not bind the verified bytes to one GitHub asset id`);
  }
}

function validateRunIdentity(runId) {
  if (!/^[1-9][0-9]*$/u.test(runId ?? '')) {
    fail('GitHub run id must be a positive decimal string');
  }
}

async function latestArtifact(latestPath) {
  if (typeof latestPath !== 'string' || latestPath.trim() === '') fail('latest.json path is required');
  const exact = path.resolve(latestPath);
  if (path.basename(exact) !== 'latest.json') fail('combined updater manifest must be named latest.json');
  const stat = await fsp.lstat(exact).catch((error) => fail(`latest.json is missing: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) fail('latest.json must be a regular non-symlink file');
  const bytes = await fsp.readFile(exact);
  if (bytes.length <= 0) fail('latest.json must not be empty');
  return {
    fileName: 'latest.json',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

export async function loadExpectedReleaseAssets({
  inventoryPath,
  receiptsDir,
  latestReceiptPath,
  latestPath,
  tag,
  runId,
}) {
  validateRunIdentity(runId);
  const inventory = await readJson(inventoryPath, 'verified aggregate inventory');
  if (!Array.isArray(inventory.targets) || inventory.targets.length !== TARGETS.length) {
    fail('verified aggregate inventory must contain exactly three targets');
  }
  const platforms = inventory.targets.map(({ platform }) => platform);
  if (!sameNames(platforms, TARGETS) || new Set(platforms).size !== TARGETS.length) {
    fail('verified aggregate inventory target set is invalid');
  }
  if (typeof receiptsDir !== 'string' || receiptsDir.trim() === '') fail('target receipt directory is required');
  const exactReceiptsDir = path.resolve(receiptsDir);
  const receiptNames = (await fsp.readdir(exactReceiptsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.startsWith('draft-upload-') && entry.name.endsWith('.json'))
    .map(({ name }) => name);
  const requiredReceiptNames = TARGETS.map((target) => `draft-upload-${target}.json`);
  if (receiptNames.length !== 3 || !sameNames(receiptNames, requiredReceiptNames)) {
    fail('current run artifact must contain exactly three target upload receipts');
  }

  const expected = [];
  for (const target of inventory.targets) {
    const expectedRoles = target.platform.endsWith('apple-darwin')
      ? ['dmg', 'updater', 'updaterSignature']
      : ['updater', 'updaterSignature'];
    if (!target.artifacts || !sameNames(Object.keys(target.artifacts), expectedRoles)) {
      fail(`${target.platform} aggregate inventory artifact roles are invalid`);
    }
    const receipt = await readJson(
      path.join(exactReceiptsDir, `draft-upload-${target.platform}.json`),
      `${target.platform} upload receipt`,
    );
    if (
      receipt.schemaVersion !== 2
      || receipt.tag !== tag
      || receipt.target !== target.platform
      || receipt.runId !== runId
    ) {
      fail(`${target.platform} upload receipt does not bind the current run, final tag, and target`);
    }
    const artifacts = Object.values(target.artifacts);
    const names = artifacts.map(({ fileName }) => fileName);
    if (!receipt.assets || !sameNames(Object.keys(receipt.assets), names)) {
      fail(`${target.platform} upload receipt asset set is not exact`);
    }
    for (const artifact of artifacts) {
      validateArtifact(artifact, `${target.platform} artifact`);
      const record = receipt.assets[artifact.fileName];
      validateReceiptRecord(record, artifact, `${target.platform} ${artifact.fileName} receipt`);
      expected.push({ fileName: artifact.fileName, ...record });
    }
  }
  if (expected.length !== 8 || new Set(expected.map(({ fileName }) => fileName)).size !== 8) {
    fail('verified target receipts must bind exactly eight unique release assets');
  }

  const latest = await latestArtifact(latestPath);
  const latestReceipt = await readJson(latestReceiptPath, 'latest.json upload receipt');
  if (
    latestReceipt.schemaVersion !== 2
    || latestReceipt.tag !== tag
    || latestReceipt.target !== 'latest'
    || latestReceipt.runId !== runId
    || !latestReceipt.assets
    || !sameNames(Object.keys(latestReceipt.assets), ['latest.json'])
  ) {
    fail('latest.json upload receipt does not bind the final tag and exact asset set');
  }
  const latestRecord = latestReceipt.assets['latest.json'];
  validateReceiptRecord(latestRecord, latest, 'latest.json upload receipt');
  return [...expected, { fileName: latest.fileName, ...latestRecord }];
}

export function validatePublicationAssets(release, expectedAssets) {
  if (!Array.isArray(expectedAssets) || expectedAssets.length !== 9) {
    fail('publication contract must contain eight target assets plus latest.json');
  }
  const expectedNames = expectedAssets.map(({ fileName }) => fileName);
  const expectedIds = expectedAssets.map(({ assetId }) => assetId);
  for (const expected of expectedAssets) {
    if (
      typeof expected?.fileName !== 'string'
      || path.basename(expected.fileName) !== expected.fileName
      || ['.', '..'].includes(expected.fileName)
      || /[\u0000-\u001f\u007f]/u.test(expected.fileName)
      || !Number.isSafeInteger(expected.assetId)
      || expected.assetId <= 0
      || !Number.isSafeInteger(expected.size)
      || expected.size <= 0
      || !/^[a-f0-9]{64}$/u.test(expected.sha256 ?? '')
    ) {
      fail('publication contract contains an invalid asset fingerprint');
    }
  }
  if (
    new Set(expectedNames).size !== 9
    || new Set(expectedIds).size !== 9
    || expectedNames.filter((name) => name === 'latest.json').length !== 1
  ) {
    fail('publication contract contains duplicate or incomplete asset identities');
  }
  if (!Array.isArray(release?.assets) || release.assets.length !== 9) {
    fail(`exact draft must contain eight target assets plus latest.json; found ${release?.assets?.length ?? 0}`);
  }
  for (const expected of expectedAssets) {
    const matches = exactAssetsNamed(release, expected.fileName);
    if (matches.length !== 1) fail(`exact draft asset set is ambiguous for ${expected.fileName}`);
    const asset = matches[0];
    if (
      asset.id !== expected.assetId
      || asset.size !== expected.size
      || asset.digest !== `sha256:${expected.sha256}`
      || asset.state !== 'uploaded'
    ) {
      fail(`exact draft asset identity changed before publication: ${expected.fileName}`);
    }
  }
}

export async function publishDraftGithubRelease({
  client,
  desiredDraft,
  expectedAssets,
  requireImmutableReleasePolicy,
}) {
  if (desiredDraft !== true && desiredDraft !== false) fail('desired draft state must be boolean');
  if (!desiredDraft && typeof requireImmutableReleasePolicy !== 'function') {
    fail('immutable release preflight is required for publication');
  }
  if (!desiredDraft) {
    // Recheck both mutable external policies after the signed build and asset
    // uploads. The exact draft GET remains the final awaited request before PATCH.
    await client.requireExpectedTagCommit();
    await requireImmutableReleasePolicy();
  }
  // Contract files are loaded before this function. This exact id + tag GET is
  // the final awaited operation before PATCH, and it also gates the exact asset set.
  const release = await client.requireDraft();
  validatePublicationAssets(release, expectedAssets);
  if (desiredDraft) return { state: 'draft', releaseId: release.id };
  const { published, confirmed } = await client.publish(release);
  validatePublicationAssets(published, expectedAssets);
  validatePublicationAssets(confirmed, expectedAssets);
  await client.requireExpectedTagCommit();
  return { state: 'published', releaseId: confirmed.id };
}

async function main() {
  const desired = process.env.DESIRED_DRAFT;
  if (!['true', 'false'].includes(desired)) fail('DESIRED_DRAFT must be true or false');
  if (!process.env.EXPECTED_RELEASE_ID) fail('EXPECTED_RELEASE_ID is required for publication');
  if (!process.env.EXPECTED_RELEASE_OWNER_RUN_ID) {
    fail('EXPECTED_RELEASE_OWNER_RUN_ID is required for publication');
  }
  if (!process.env.EXPECTED_RELEASE_SOURCE_COMMIT) {
    fail('EXPECTED_RELEASE_SOURCE_COMMIT is required for publication');
  }
  const client = new DraftReleaseClient({
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.TAG_NAME,
    token: process.env.GITHUB_TOKEN,
    expectedReleaseId: process.env.EXPECTED_RELEASE_ID,
    expectedOwnerRunId: process.env.EXPECTED_RELEASE_OWNER_RUN_ID,
    expectedSourceCommit: process.env.EXPECTED_RELEASE_SOURCE_COMMIT,
  });
  const expectedAssets = await loadExpectedReleaseAssets({
    inventoryPath: process.env.CCEM_RELEASE_INVENTORY_PATH,
    receiptsDir: process.env.CCEM_RELEASE_RECEIPTS_DIR,
    latestReceiptPath: process.env.CCEM_RELEASE_LATEST_RECEIPT_PATH,
    latestPath: process.env.CCEM_RELEASE_LATEST_PATH,
    tag: client.tag,
    runId: process.env.GITHUB_RUN_ID,
  });
  const result = await publishDraftGithubRelease({
    client,
    desiredDraft: desired === 'true',
    expectedAssets,
    requireImmutableReleasePolicy: desired === 'false'
      ? () => verifyImmutableReleasesEnabled({
        repository: process.env.GITHUB_REPOSITORY,
        token: process.env.CCEM_RELEASE_SETTINGS_TOKEN,
      })
      : undefined,
  });
  process.stdout.write(`[publish-draft-github-release] ${result.state}\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
