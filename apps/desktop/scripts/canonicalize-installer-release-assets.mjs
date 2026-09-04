import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { fingerprintReleaseFile, RELEASE_TARGETS } from './release-asset-discovery.mjs';

const TARGET_CONFIG = Object.freeze({
  'aarch64-apple-darwin': { directory: 'dmg', suffix: '.dmg', architecture: 'aarch64', signature: false },
  'x86_64-apple-darwin': { directory: 'dmg', suffix: '.dmg', architecture: 'x64', signature: false },
  'x86_64-pc-windows-msvc': { directory: 'nsis', suffix: '-setup.exe', architecture: 'x64', signature: true },
});

function fail(message) {
  throw new Error(`[canonicalize-installer-release-assets] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

function exactVersion(value) {
  const version = required(value, 'release version');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)) {
    fail('release version must be an exact supported semantic version');
  }
  return version;
}

function targetConfig(target) {
  const exact = required(target, 'release target');
  if (!RELEASE_TARGETS.includes(exact) || !TARGET_CONFIG[exact]) fail(`unsupported release target: ${exact}`);
  return { target: exact, ...TARGET_CONFIG[exact] };
}

export function canonicalInstallerBasename(target, version) {
  const config = targetConfig(target);
  return `CCEM.Desktop_${exactVersion(version)}_${config.architecture}${config.suffix}`;
}

async function requireDirectory(candidate, label) {
  const exact = path.resolve(required(candidate, label));
  const stat = await fsp.lstat(exact).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink directory`);
  return exact;
}

async function missing(candidate) {
  return fsp.lstat(candidate).then(() => false, (error) => {
    if (error?.code === 'ENOENT') return true;
    throw error;
  });
}

function sameFingerprint(left, right) {
  return left.size === right.size && left.sha256 === right.sha256;
}

async function cleanupDestinations(records) {
  const errors = [];
  for (const record of [...records].reverse()) {
    try {
      if (await missing(record.destination)) continue;
      const current = await fingerprintReleaseFile(record.destination, 'partially canonicalized installer');
      if (!sameFingerprint(current, record.fingerprint)) {
        errors.push(`${path.basename(record.destination)} changed before rollback`);
        continue;
      }
      await fsp.unlink(record.destination);
    } catch (error) {
      errors.push(`${path.basename(record.destination)}: ${error.message}`);
    }
  }
  return errors;
}

async function restoreSources(records) {
  const errors = [];
  for (const record of records) {
    try {
      if (!await missing(record.source)) continue;
      await fsp.copyFile(record.destination, record.source, fsConstants.COPYFILE_EXCL);
      const restored = await fingerprintReleaseFile(record.source, 'restored installer asset');
      if (!sameFingerprint(restored, record.fingerprint)) {
        errors.push(`${path.basename(record.source)} restored with different bytes`);
      }
    } catch (error) {
      errors.push(`${path.basename(record.source)}: ${error.message}`);
    }
  }
  return errors;
}

export async function canonicalizeInstallerReleaseAssets(options) {
  const config = targetConfig(options?.target);
  const version = exactVersion(options?.version);
  const bundleRoot = await requireDirectory(options?.bundleRoot, 'release bundle root');
  const directory = await requireDirectory(path.join(bundleRoot, config.directory), 'installer bundle directory');
  const canonicalName = canonicalInstallerBasename(config.target, version);
  const canonicalNames = config.signature ? [canonicalName, `${canonicalName}.sig`] : [canonicalName];
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const installerEntries = entries.filter(({ name }) => (
    name.endsWith(config.suffix) && !name.endsWith(`${config.suffix}.sig`)
  ));
  const signatureEntries = config.signature
    ? entries.filter(({ name }) => name.endsWith(`${config.suffix}.sig`))
    : [];
  const alreadyCanonical = installerEntries.length === 1
    && installerEntries[0].name === canonicalName
    && (!config.signature || (signatureEntries.length === 1 && signatureEntries[0].name === `${canonicalName}.sig`));
  if (alreadyCanonical) {
    const installerPath = path.join(directory, canonicalName);
    await fingerprintReleaseFile(installerPath, 'canonical installer');
    const signaturePath = config.signature ? `${installerPath}.sig` : null;
    if (signaturePath) await fingerprintReleaseFile(signaturePath, 'canonical installer signature');
    return { changed: false, target: config.target, installerPath, signaturePath };
  }

  const expectedFolds = new Set(canonicalNames.map((name) => name.toLowerCase()));
  if (entries.some(({ name }) => expectedFolds.has(name.toLowerCase()))) {
    fail(`target collision for ${canonicalName}`);
  }
  if (installerEntries.length !== 1) fail(`expected exactly one installer asset; found ${installerEntries.length}`);
  if (config.signature && signatureEntries.length !== 1) {
    fail(`expected exactly one installer signature; found ${signatureEntries.length}`);
  }
  if (config.signature && signatureEntries[0].name !== `${installerEntries[0].name}.sig`) {
    fail('installer signature basename must exactly match its installer');
  }

  const sourceNames = config.signature
    ? [installerEntries[0].name, signatureEntries[0].name]
    : [installerEntries[0].name];
  const records = [];
  for (let index = 0; index < sourceNames.length; index += 1) {
    const source = path.join(directory, sourceNames[index]);
    const destination = path.join(directory, canonicalNames[index]);
    const fingerprint = await fingerprintReleaseFile(source, 'source installer asset');
    records.push({ source, destination, fingerprint });
  }

  const created = [];
  try {
    for (const record of records) {
      await fsp.copyFile(record.source, record.destination, fsConstants.COPYFILE_EXCL);
      created.push(record);
      const copied = await fingerprintReleaseFile(record.destination, 'canonical installer asset');
      if (!sameFingerprint(copied, record.fingerprint)) fail(`${path.basename(record.destination)} bytes changed while copying`);
    }
  } catch (error) {
    const rollback = await cleanupDestinations(created);
    fail(`${error.message}${rollback.length > 0 ? `; rollback incomplete: ${rollback.join('; ')}` : ''}`);
  }

  const removed = [];
  try {
    for (const record of records) {
      await fsp.unlink(record.source);
      removed.push(record);
    }
  } catch (error) {
    const rollback = [...await restoreSources(removed), ...await cleanupDestinations(created)];
    fail(`${error.message}${rollback.length > 0 ? `; rollback incomplete: ${rollback.join('; ')}` : ''}`);
  }

  return {
    changed: true,
    target: config.target,
    installerPath: records[0].destination,
    signaturePath: config.signature ? records[1].destination : null,
  };
}

function parseArguments(argv) {
  const values = {};
  const options = new Map([
    ['--target', 'target'],
    ['--version', 'version'],
    ['--bundle-root', 'bundleRoot'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = options.get(argv[index]);
    if (!key || index + 1 >= argv.length || Object.hasOwn(values, key)) fail(`invalid argument: ${argv[index] ?? '<missing>'}`);
    values[key] = argv[index + 1];
  }
  if (Object.keys(values).length !== options.size) fail('target, version, and bundle root are required');
  return values;
}

async function main() {
  const result = await canonicalizeInstallerReleaseAssets(parseArguments(process.argv.slice(2)));
  process.stdout.write(`[canonicalize-installer-release-assets] ${result.target}: ${path.basename(result.installerPath)}\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
