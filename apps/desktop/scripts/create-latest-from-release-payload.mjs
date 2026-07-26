import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PLATFORM_TARGETS = Object.freeze({
  'darwin-aarch64': 'aarch64-apple-darwin',
  'darwin-x86_64': 'x86_64-apple-darwin',
  'windows-x86_64': 'x86_64-pc-windows-msvc',
});

function fail(message) {
  throw new Error(`[create-latest-from-release-payload] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

function validateRepository(value) {
  const repository = required(value, 'GitHub repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) fail('invalid GitHub repository');
  return repository;
}

async function readJson(candidate, label) {
  const exact = path.resolve(required(candidate, `${label} path`));
  const stat = await fsp.lstat(exact).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  try {
    return JSON.parse(await fsp.readFile(exact, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

async function verifyAsset(record, label) {
  if (
    !record
    || typeof record.path !== 'string'
    || typeof record.fileName !== 'string'
    || path.basename(record.fileName) !== record.fileName
    || !/^[a-f0-9]{64}$/u.test(record.sha256 ?? '')
    || !Number.isSafeInteger(record.size)
    || record.size <= 0
  ) {
    fail(`${label} has an invalid payload fingerprint`);
  }
  const exact = path.resolve(record.path);
  const stat = await fsp.lstat(exact).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size) {
    fail(`${label} must remain the exact regular payload file`);
  }
  const bytes = await fsp.readFile(exact);
  if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) {
    fail(`${label} changed after payload verification`);
  }
  return bytes;
}

function downloadUrl(repository, tag, fileName) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
}

function updaterSignature(bytes, label) {
  const signature = bytes.toString('utf8').replace(/\r?\n$/u, '').trim();
  if (signature === '' || /[\u0000-\u001f\u007f]/u.test(signature)) fail(`${label} is not a valid updater signature`);
  return signature;
}

async function writeJsonAtomically(candidate, value) {
  const output = path.resolve(required(candidate, 'latest.json output path'));
  if (path.basename(output) !== 'latest.json') fail('combined updater manifest must be named latest.json');
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, output);
}

export async function createLatestFromReleasePayload({
  contractPath,
  outputPath,
  repository,
  tag,
  version,
  pubDate,
  runId,
}) {
  const contract = await readJson(contractPath, 'verified payload contract');
  const exactRepository = validateRepository(repository);
  const exactTag = required(tag, 'release tag');
  const exactVersion = required(version, 'release version');
  const exactPubDate = required(pubDate, 'release publication date');
  const exactRunId = required(runId, 'GitHub run id');
  if (!/^[1-9][0-9]*$/u.test(exactRunId)) fail('GitHub run id must be a positive decimal string');
  if (Number.isNaN(Date.parse(exactPubDate))) fail('release publication date must be ISO-8601 compatible');
  if (
    contract?.schemaVersion !== 1
    || contract.runId !== exactRunId
    || contract.tag !== exactTag
    || contract.appVersion !== exactVersion
    || !Array.isArray(contract.targets)
    || contract.targets.length !== 3
  ) {
    fail('verified payload contract does not bind the current run, tag, and version');
  }
  const targets = new Map(contract.targets.map((target) => [target?.target, target]));
  if (targets.size !== 3 || Object.values(PLATFORM_TARGETS).some((target) => !targets.has(target))) {
    fail('verified payload contract target set is invalid');
  }

  const platforms = {};
  for (const [platform, target] of Object.entries(PLATFORM_TARGETS)) {
    const targetContract = targets.get(target);
    const updater = targetContract?.assets?.updater;
    const signature = targetContract?.assets?.updaterSignature;
    await verifyAsset(updater, `${target} updater`);
    const signatureBytes = await verifyAsset(signature, `${target} updater signature`);
    platforms[platform] = {
      signature: updaterSignature(signatureBytes, `${target} updater signature`),
      url: downloadUrl(exactRepository, exactTag, updater.fileName),
    };
  }
  const latest = {
    version: exactVersion,
    notes: `See https://github.com/${exactRepository}/releases/tag/${encodeURIComponent(exactTag)}`,
    pub_date: exactPubDate,
    platforms,
  };
  await writeJsonAtomically(outputPath, latest);
  return latest;
}

async function main() {
  await createLatestFromReleasePayload({
    contractPath: process.env.CCEM_RELEASE_PAYLOAD_CONTRACT,
    outputPath: process.env.CCEM_RELEASE_LATEST_PATH,
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.TAG_NAME,
    version: process.env.VERSION,
    pubDate: process.env.PUB_DATE,
    runId: process.env.GITHUB_RUN_ID,
  });
  process.stdout.write('[create-latest-from-release-payload] latest.json verified\n');
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
