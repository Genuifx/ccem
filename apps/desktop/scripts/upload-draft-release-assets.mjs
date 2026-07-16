import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { DraftReleaseClient, exactAssetsNamed } from './github-draft-release-api.mjs';

const MAC_TARGETS = new Set(['aarch64-apple-darwin', 'x86_64-apple-darwin']);
const WINDOWS_TARGET = 'x86_64-pc-windows-msvc';
const RELEASE_TARGETS = [...MAC_TARGETS, WINDOWS_TARGET];

function fail(message) {
  throw new Error(`[upload-draft-release-assets] ${message}`);
}

async function requireFile(candidate, label) {
  let stat;
  try {
    stat = await fsp.lstat(candidate);
  } catch (error) {
    fail(`${label} is missing: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return stat;
}

async function sha256(candidate) {
  const hash = createHash('sha256');
  const handle = await fsp.open(candidate, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

async function candidateMetadata(candidate, contentType) {
  const exact = path.resolve(candidate);
  const stat = await requireFile(exact, path.basename(exact));
  const fileName = path.basename(exact);
  if (
    ['.', '..'].includes(fileName)
    || /[\u0000-\u001f\u007f]/u.test(fileName)
    || fileName !== path.basename(fileName)
  ) {
    fail(`invalid release asset basename: ${fileName}`);
  }
  return {
    path: exact,
    fileName,
    contentType,
    sha256: await sha256(exact),
    size: stat.size,
  };
}

async function exactMatches(directory, predicate, label) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const matches = entries.filter((entry) => entry.isFile() && predicate(entry.name));
  if (matches.length !== 1) fail(`expected exactly one ${label}; found ${matches.length}`);
  return path.join(directory, matches[0].name);
}

export async function discoverTargetAssets(desktopDir, target) {
  if (!MAC_TARGETS.has(target) && target !== WINDOWS_TARGET) fail(`unsupported release target: ${target}`);
  const bundleRoot = path.join(desktopDir, 'src-tauri', 'target', target, 'release', 'bundle');
  let candidates;
  if (MAC_TARGETS.has(target)) {
    const dmgRoot = path.join(bundleRoot, 'dmg');
    const macRoot = path.join(bundleRoot, 'macos');
    const dmg = await exactMatches(dmgRoot, (name) => name.endsWith('.dmg'), 'macOS DMG');
    const updater = await exactMatches(macRoot, (name) => name.endsWith('.app.tar.gz'), 'macOS updater archive');
    const signature = await exactMatches(macRoot, (name) => name.endsWith('.app.tar.gz.sig'), 'macOS updater signature');
    candidates = [
      await candidateMetadata(dmg, 'application/x-apple-diskimage'),
      await candidateMetadata(updater, 'application/gzip'),
      await candidateMetadata(signature, 'application/octet-stream'),
    ];
  } else {
    const nsisRoot = path.join(bundleRoot, 'nsis');
    const updater = await exactMatches(nsisRoot, (name) => /-setup\.exe$/u.test(name), 'Windows NSIS updater');
    const signature = await exactMatches(nsisRoot, (name) => /-setup\.exe\.sig$/u.test(name), 'Windows updater signature');
    candidates = [
      await candidateMetadata(updater, 'application/vnd.microsoft.portable-executable'),
      await candidateMetadata(signature, 'application/octet-stream'),
    ];
  }
  const names = candidates.map(({ fileName }) => fileName);
  if (new Set(names).size !== names.length) fail('current target release asset basenames must be unique');
  return candidates;
}

async function assetBytesMatch(client, asset, candidate) {
  if (asset?.size !== candidate.size) return false;
  if (asset.digest != null) return asset.digest === `sha256:${candidate.sha256}`;
  const downloaded = await client.downloadAssetFingerprint(asset);
  return downloaded.size === candidate.size && downloaded.sha256 === candidate.sha256;
}

function validateUploadedAsset(asset, candidate) {
  if (
    asset?.name !== candidate.fileName
    || !Number.isSafeInteger(asset.id)
    || asset.id <= 0
    || asset.size !== candidate.size
    || asset.digest !== `sha256:${candidate.sha256}`
    || asset.state !== 'uploaded'
  ) {
    fail(`GitHub did not return the exact uploaded asset metadata for ${candidate.fileName}`);
  }
}

function validateConfirmedAsset(asset, candidate, expectedAssetId) {
  if (
    asset?.id !== expectedAssetId
    || asset.name !== candidate.fileName
    || asset.size !== candidate.size
    || asset.digest !== `sha256:${candidate.sha256}`
    || asset.state !== 'uploaded'
  ) {
    fail(`release asset identity changed after upload or reuse: ${candidate.fileName}`);
  }
}

async function confirmAssetStillOnDraft(client, candidate, expectedAsset) {
  const release = await client.requireDraft();
  const matches = exactAssetsNamed(release, candidate.fileName);
  if (matches.length !== 1) {
    fail(`release asset is not unique after upload or reuse: ${candidate.fileName}`);
  }
  validateConfirmedAsset(matches[0], candidate, expectedAsset.id);
  return matches[0];
}

async function confirmAssetSetStillOnDraft(client, records) {
  const release = await client.requireDraft();
  for (const { candidate, asset } of records) {
    const matches = exactAssetsNamed(release, candidate.fileName);
    if (matches.length !== 1) {
      fail(`release asset is not unique before receipt: ${candidate.fileName}`);
    }
    validateConfirmedAsset(matches[0], candidate, asset.id);
  }
}

async function uploadAbsentAsset(client, candidate) {
  // This is intentionally the final awaited read before the POST mutation.
  const release = await client.requireDraft();
  if (exactAssetsNamed(release, candidate.fileName).length !== 0) {
    fail(`release asset appeared before upload: ${candidate.fileName}`);
  }
  const uploaded = await client.uploadAsset(release, candidate);
  validateUploadedAsset(uploaded, candidate);
  return uploaded;
}

export async function uploadCandidateIdempotently(client, candidate) {
  const release = await client.requireDraft();
  const collisions = exactAssetsNamed(release, candidate.fileName);
  if (collisions.length > 1) fail(`duplicate release assets exist for ${candidate.fileName}`);
  let asset;
  let uploaded;
  if (collisions.length === 1) {
    if (!await assetBytesMatch(client, collisions[0], candidate)) {
      fail(`release asset collision does not match current bytes: ${candidate.fileName}`);
    }
    asset = collisions[0];
    uploaded = false;
  } else {
    asset = await uploadAbsentAsset(client, candidate);
    uploaded = true;
  }
  return {
    asset: await confirmAssetStillOnDraft(client, candidate, asset),
    uploaded,
  };
}

async function writeJsonAtomically(candidate, value) {
  if (typeof candidate !== 'string' || candidate.trim() === '') fail('receipt output path is required');
  const output = path.resolve(candidate);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, output);
}

function releaseRunIdentity(runId) {
  if (!/^[1-9][0-9]*$/u.test(runId ?? '')) {
    fail('GitHub run id must be a positive decimal string');
  }
  return { runId };
}

function receiptFingerprint(asset, candidate) {
  return {
    assetId: asset.id,
    sha256: candidate.sha256,
    size: candidate.size,
  };
}

export async function uploadDraftTargetAssets({
  client,
  desktopDir,
  target,
  receiptPath,
  runId,
}) {
  const run = releaseRunIdentity(runId);
  const candidates = await discoverTargetAssets(desktopDir, target);
  const assets = {};
  const confirmed = [];
  for (const candidate of candidates) {
    const result = await uploadCandidateIdempotently(client, candidate);
    assets[candidate.fileName] = receiptFingerprint(result.asset, candidate);
    confirmed.push({ candidate, asset: result.asset });
  }
  await confirmAssetSetStillOnDraft(client, confirmed);
  const receipt = {
    schemaVersion: 2,
    tag: client.tag,
    target,
    ...run,
    assets,
  };
  await writeJsonAtomically(receiptPath, receipt);
  return receipt;
}

export async function uploadLatestJson({
  client,
  latestPath,
  receiptPath,
  runId,
}) {
  const run = releaseRunIdentity(runId);
  const candidate = await candidateMetadata(latestPath, 'application/json');
  if (candidate.fileName !== 'latest.json') fail('combined updater manifest must be named latest.json');
  const result = await uploadCandidateIdempotently(client, candidate);
  await confirmAssetSetStillOnDraft(client, [{ candidate, asset: result.asset }]);
  await writeJsonAtomically(receiptPath, {
    schemaVersion: 2,
    tag: client.tag,
    target: 'latest',
    ...run,
    assets: { [candidate.fileName]: receiptFingerprint(result.asset, candidate) },
  });
  return result;
}

function sameSet(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

async function readVerifiedContract(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') fail('verified payload contract path is required');
  const exact = path.resolve(candidate);
  const stat = await requireFile(exact, 'verified payload contract');
  if (stat.size <= 0) fail('verified payload contract must not be empty');
  try {
    return JSON.parse(await fsp.readFile(exact, 'utf8'));
  } catch (error) {
    fail(`verified payload contract is not valid JSON: ${error.message}`);
  }
}

function validateContractAsset(record, label) {
  if (
    !record
    || typeof record.path !== 'string'
    || typeof record.fileName !== 'string'
    || path.basename(record.fileName) !== record.fileName
    || ['.', '..', 'latest.json'].includes(record.fileName)
    || typeof record.contentType !== 'string'
    || record.contentType.trim() === ''
    || !Number.isSafeInteger(record.size)
    || record.size <= 0
    || !/^[a-f0-9]{64}$/u.test(record.sha256 ?? '')
  ) {
    fail(`${label} has an invalid verified payload fingerprint`);
  }
}

export async function uploadVerifiedPayloadContract({
  client,
  contractPath,
  receiptsDir,
  runId,
}) {
  const run = releaseRunIdentity(runId);
  const contract = await readVerifiedContract(contractPath);
  if (
    contract?.schemaVersion !== 1
    || contract.runId !== run.runId
    || contract.tag !== client.tag
    || !Array.isArray(contract.targets)
    || contract.targets.length !== RELEASE_TARGETS.length
    || !sameSet(contract.targets.map(({ target }) => target), RELEASE_TARGETS)
  ) {
    fail('verified payload contract does not bind the current run, tag, and exact target set');
  }
  const outputDirectory = path.resolve(receiptsDir);
  await fsp.mkdir(outputDirectory, { recursive: true });
  const allNames = new Set();
  const receipts = [];
  for (const targetContract of contract.targets) {
    const expectedRoles = MAC_TARGETS.has(targetContract.target)
      ? ['dmg', 'updater', 'updaterSignature']
      : ['updater', 'updaterSignature'];
    if (!sameSet(Object.keys(targetContract.assets ?? {}), expectedRoles)) {
      fail(`${targetContract.target} verified payload role set is invalid`);
    }
    const assets = {};
    const confirmed = [];
    for (const role of expectedRoles) {
      const record = targetContract.assets[role];
      validateContractAsset(record, `${targetContract.target} ${role}`);
      if (allNames.has(record.fileName)) fail(`duplicate release asset basename: ${record.fileName}`);
      allNames.add(record.fileName);
      const candidate = await candidateMetadata(record.path, record.contentType);
      if (
        candidate.fileName !== record.fileName
        || candidate.size !== record.size
        || candidate.sha256 !== record.sha256
      ) {
        fail(`${targetContract.target} ${role} changed after payload verification`);
      }
      const result = await uploadCandidateIdempotently(client, candidate);
      assets[candidate.fileName] = receiptFingerprint(result.asset, candidate);
      confirmed.push({ candidate, asset: result.asset });
    }
    await confirmAssetSetStillOnDraft(client, confirmed);
    const receipt = {
      schemaVersion: 2,
      tag: client.tag,
      target: targetContract.target,
      ...run,
      assets,
    };
    await writeJsonAtomically(
      path.join(outputDirectory, `draft-upload-${targetContract.target}.json`),
      receipt,
    );
    receipts.push(receipt);
  }
  if (allNames.size !== 8) fail(`verified payload contract must contain exactly eight assets; found ${allNames.size}`);
  return receipts;
}

function parseCli(args) {
  const index = args.indexOf('--mode');
  const mode = index >= 0 ? args[index + 1] : null;
  if (args.length !== 2 || index !== 0 || !['target', 'payload', 'latest'].includes(mode)) {
    fail('Usage: node scripts/upload-draft-release-assets.mjs --mode <target|payload|latest>');
  }
  return mode;
}

async function main() {
  const mode = parseCli(process.argv.slice(2));
  if (!process.env.EXPECTED_RELEASE_ID) fail('EXPECTED_RELEASE_ID is required for release mutation');
  if (!process.env.EXPECTED_RELEASE_OWNER_RUN_ID) {
    fail('EXPECTED_RELEASE_OWNER_RUN_ID is required for release mutation');
  }
  if (!process.env.EXPECTED_RELEASE_SOURCE_COMMIT) {
    fail('EXPECTED_RELEASE_SOURCE_COMMIT is required for release mutation');
  }
  const client = new DraftReleaseClient({
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.TAG_NAME,
    token: process.env.GITHUB_TOKEN,
    expectedReleaseId: process.env.EXPECTED_RELEASE_ID,
    expectedOwnerRunId: process.env.EXPECTED_RELEASE_OWNER_RUN_ID,
    expectedSourceCommit: process.env.EXPECTED_RELEASE_SOURCE_COMMIT,
  });
  const desktopDir = path.resolve(process.cwd());
  if (mode === 'target') {
    const target = process.env.CCEM_RELEASE_TARGET;
    await uploadDraftTargetAssets({
      client,
      desktopDir,
      target,
      receiptPath: path.join(desktopDir, 'src-tauri', 'target', 'release-gates', `draft-upload-${target}.json`),
      runId: process.env.GITHUB_RUN_ID,
    });
  } else if (mode === 'payload') {
    await uploadVerifiedPayloadContract({
      client,
      contractPath: process.env.CCEM_RELEASE_PAYLOAD_CONTRACT,
      receiptsDir: process.env.CCEM_RELEASE_RECEIPTS_DIR,
      runId: process.env.GITHUB_RUN_ID,
    });
  } else {
    await uploadLatestJson({
      client,
      latestPath: process.env.CCEM_RELEASE_ASSET_PATH,
      receiptPath: process.env.CCEM_RELEASE_RECEIPT_PATH,
      runId: process.env.GITHUB_RUN_ID,
    });
  }
  process.stdout.write(`[upload-draft-release-assets] ${mode}: verified\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
