import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAC_UPDATER_BASENAMES = Object.freeze({
  'aarch64-apple-darwin': 'CCEM.Desktop_aarch64.app.tar.gz',
  'x86_64-apple-darwin': 'CCEM.Desktop_x64.app.tar.gz',
});

function fail(message) {
  throw new Error(`[canonicalize-macos-release-assets] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

export function canonicalMacUpdaterBasename(target) {
  const exactTarget = required(target, 'macOS release target');
  const basename = MAC_UPDATER_BASENAMES[exactTarget];
  if (!basename) fail(`unsupported macOS release target: ${exactTarget}`);
  return basename;
}

async function requireDirectory(candidate) {
  const exact = path.resolve(required(candidate, 'macOS bundle directory'));
  const stat = await fsp.lstat(exact).catch((error) => (
    fail(`macOS bundle directory is missing: ${error.message}`)
  ));
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('macOS bundle directory must be a regular non-symlink directory');
  }
  return exact;
}

async function requireRegularFile(candidate, label) {
  const stat = await fsp.lstat(candidate).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  if (stat.size <= 0) fail(`${label} must not be empty`);
  return stat;
}

async function fingerprint(candidate, label) {
  const stat = await requireRegularFile(candidate, label);
  const hash = createHash('sha256');
  const handle = await fsp.open(candidate, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return { size: stat.size, sha256: hash.digest('hex') };
}

function sameFingerprint(actual, expected) {
  return actual.size === expected.size && actual.sha256 === expected.sha256;
}

async function pathMissing(candidate) {
  try {
    await fsp.lstat(candidate);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

async function cleanupCreated(paths, expectedByPath, unlink) {
  const errors = [];
  for (const candidate of [...paths].reverse()) {
    try {
      if (await pathMissing(candidate)) continue;
      const actual = await fingerprint(candidate, 'partially created canonical asset');
      if (!sameFingerprint(actual, expectedByPath.get(candidate))) {
        errors.push(`${path.basename(candidate)} changed before rollback`);
        continue;
      }
      await unlink(candidate);
    } catch (error) {
      errors.push(`${path.basename(candidate)}: ${error.message}`);
    }
  }
  return errors;
}

async function restoreRemoved(records, copyFile) {
  const errors = [];
  for (const record of records) {
    try {
      if (!await pathMissing(record.source)) continue;
      await copyFile(record.destination, record.source, fsConstants.COPYFILE_EXCL);
      const restored = await fingerprint(record.source, 'restored original asset');
      if (!sameFingerprint(restored, record.fingerprint)) {
        errors.push(`${path.basename(record.source)} restored with different bytes`);
      }
    } catch (error) {
      errors.push(`${path.basename(record.source)}: ${error.message}`);
    }
  }
  return errors;
}

export async function canonicalizeMacUpdaterAssets(options, operations = {}) {
  const target = required(options?.target, 'macOS release target');
  const canonicalUpdaterName = canonicalMacUpdaterBasename(target);
  const canonicalSignatureName = `${canonicalUpdaterName}.sig`;
  const directory = await requireDirectory(options?.bundleDirectory);
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const updaterEntries = entries.filter(({ name }) => name.toLowerCase().endsWith('.app.tar.gz'));
  const signatureEntries = entries.filter(({ name }) => name.toLowerCase().endsWith('.app.tar.gz.sig'));
  const canonicalUpdaterFold = canonicalUpdaterName.toLowerCase();
  const canonicalSignatureFold = canonicalSignatureName.toLowerCase();
  const updaterCollisions = entries.filter(({ name }) => name.toLowerCase() === canonicalUpdaterFold);
  const signatureCollisions = entries.filter(({ name }) => name.toLowerCase() === canonicalSignatureFold);
  const alreadyCanonical = updaterEntries.length === 1
    && signatureEntries.length === 1
    && updaterEntries[0].name === canonicalUpdaterName
    && signatureEntries[0].name === canonicalSignatureName;

  if (alreadyCanonical) {
    const updaterPath = path.join(directory, canonicalUpdaterName);
    const signaturePath = path.join(directory, canonicalSignatureName);
    const updater = await fingerprint(updaterPath, 'canonical macOS updater archive');
    const signature = await fingerprint(signaturePath, 'canonical macOS updater signature');
    return { changed: false, target, updaterPath, signaturePath, updater, signature };
  }
  if (updaterCollisions.length > 0 || signatureCollisions.length > 0) {
    fail(`target collision for ${canonicalUpdaterName}`);
  }
  if (updaterEntries.length !== 1) {
    fail(`expected exactly one macOS updater archive; found ${updaterEntries.length}`);
  }
  if (signatureEntries.length !== 1) {
    fail(`expected exactly one macOS updater signature; found ${signatureEntries.length}`);
  }

  const sourceUpdaterName = updaterEntries[0].name;
  const sourceSignatureName = signatureEntries[0].name;
  if (sourceSignatureName !== `${sourceUpdaterName}.sig`) {
    fail('macOS updater signature basename must exactly match its updater archive');
  }
  const sourceUpdaterPath = path.join(directory, sourceUpdaterName);
  const sourceSignaturePath = path.join(directory, sourceSignatureName);
  const updaterPath = path.join(directory, canonicalUpdaterName);
  const signaturePath = path.join(directory, canonicalSignatureName);
  const sourceUpdater = await fingerprint(sourceUpdaterPath, 'source macOS updater archive');
  const sourceSignature = await fingerprint(sourceSignaturePath, 'source macOS updater signature');
  const expectedByPath = new Map([
    [updaterPath, sourceUpdater],
    [signaturePath, sourceSignature],
  ]);
  const copyFile = operations.copyFile ?? fsp.copyFile.bind(fsp);
  const unlink = operations.unlink ?? fsp.unlink.bind(fsp);
  const created = [];

  try {
    await copyFile(sourceUpdaterPath, updaterPath, fsConstants.COPYFILE_EXCL);
    created.push(updaterPath);
    await copyFile(sourceSignaturePath, signaturePath, fsConstants.COPYFILE_EXCL);
    created.push(signaturePath);
    for (const [candidate, expected] of expectedByPath) {
      const actual = await fingerprint(candidate, 'canonical macOS updater asset');
      if (!sameFingerprint(actual, expected)) fail(`${path.basename(candidate)} bytes changed while copying`);
    }
    const currentUpdater = await fingerprint(sourceUpdaterPath, 'source macOS updater archive');
    const currentSignature = await fingerprint(sourceSignaturePath, 'source macOS updater signature');
    if (!sameFingerprint(currentUpdater, sourceUpdater) || !sameFingerprint(currentSignature, sourceSignature)) {
      fail('source updater pair changed while creating canonical assets');
    }
  } catch (error) {
    const cleanupErrors = await cleanupCreated(created, expectedByPath, unlink);
    const suffix = cleanupErrors.length > 0 ? `; rollback incomplete: ${cleanupErrors.join('; ')}` : '';
    fail(`${error.message}${suffix}`);
  }

  const removed = [];
  try {
    await unlink(sourceUpdaterPath);
    removed.push({ source: sourceUpdaterPath, destination: updaterPath, fingerprint: sourceUpdater });
    await unlink(sourceSignaturePath);
    removed.push({ source: sourceSignaturePath, destination: signaturePath, fingerprint: sourceSignature });
  } catch (error) {
    const restoreErrors = await restoreRemoved(removed, copyFile);
    const cleanupErrors = await cleanupCreated(created, expectedByPath, unlink);
    const rollbackErrors = [...restoreErrors, ...cleanupErrors];
    const suffix = rollbackErrors.length > 0 ? `; rollback incomplete: ${rollbackErrors.join('; ')}` : '';
    fail(`${error.message}${suffix}`);
  }

  const updater = await fingerprint(updaterPath, 'canonical macOS updater archive');
  const signature = await fingerprint(signaturePath, 'canonical macOS updater signature');
  if (!sameFingerprint(updater, sourceUpdater) || !sameFingerprint(signature, sourceSignature)) {
    fail('canonical updater pair changed after source removal');
  }
  return { changed: true, target, updaterPath, signaturePath, updater, signature };
}

function parseArguments(argv) {
  const values = {};
  const options = new Map([
    ['--target', 'target'],
    ['--bundle-directory', 'bundleDirectory'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = options.get(argv[index]);
    if (!key || index + 1 >= argv.length || Object.hasOwn(values, key)) {
      fail(`invalid argument: ${argv[index] ?? '<missing>'}`);
    }
    values[key] = argv[index + 1];
  }
  if (Object.keys(values).length !== options.size) {
    fail('target and bundle directory are required');
  }
  return values;
}

async function main() {
  const result = await canonicalizeMacUpdaterAssets(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `[canonicalize-macos-release-assets] ${result.target}: ${path.basename(result.updaterPath)}\n`,
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
