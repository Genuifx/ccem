import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MAC_RELEASE_TARGETS = Object.freeze([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
]);
export const WINDOWS_RELEASE_TARGET = 'x86_64-pc-windows-msvc';
export const RELEASE_TARGETS = Object.freeze([
  ...MAC_RELEASE_TARGETS,
  WINDOWS_RELEASE_TARGET,
]);

const MAC_TARGETS = new Set(MAC_RELEASE_TARGETS);

function fail(message) {
  throw new Error(`[release-asset-discovery] ${message}`);
}

export function isMacReleaseTarget(target) {
  return MAC_TARGETS.has(target);
}

export async function requireRegularReleaseFile(candidate, label) {
  let stat;
  try {
    stat = await fsp.lstat(candidate);
  } catch (error) {
    fail(`${label} is missing: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  return stat;
}

export async function fingerprintReleaseFile(candidate, label = path.basename(candidate)) {
  const exact = path.resolve(candidate);
  const stat = await requireRegularReleaseFile(exact, label);
  const hash = createHash('sha256');
  const handle = await fsp.open(exact, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return { size: stat.size, sha256: hash.digest('hex') };
}

export async function releaseAssetMetadata(candidate, contentType) {
  const exact = path.resolve(candidate);
  const fileName = path.basename(exact);
  if (
    ['.', '..'].includes(fileName)
    || /[\u0000-\u001f\u007f]/u.test(fileName)
    || fileName !== path.basename(fileName)
  ) {
    fail(`invalid release asset basename: ${fileName}`);
  }
  const fingerprint = await fingerprintReleaseFile(exact, fileName);
  return {
    path: exact,
    fileName,
    contentType,
    sha256: fingerprint.sha256,
    size: fingerprint.size,
  };
}

async function exactMatches(directory, predicate, label) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const matches = entries.filter((entry) => entry.isFile() && predicate(entry.name));
  if (matches.length !== 1) fail(`expected exactly one ${label}; found ${matches.length}`);
  return path.join(directory, matches[0].name);
}

export async function discoverTargetAssets(desktopDir, target) {
  if (!RELEASE_TARGETS.includes(target)) fail(`unsupported release target: ${target}`);
  const bundleRoot = path.join(desktopDir, 'src-tauri', 'target', target, 'release', 'bundle');
  let candidates;
  if (isMacReleaseTarget(target)) {
    const dmgRoot = path.join(bundleRoot, 'dmg');
    const macRoot = path.join(bundleRoot, 'macos');
    const dmg = await exactMatches(dmgRoot, (name) => name.endsWith('.dmg'), 'macOS DMG');
    const updater = await exactMatches(
      macRoot,
      (name) => name.endsWith('.app.tar.gz'),
      'macOS updater archive',
    );
    const signature = await exactMatches(
      macRoot,
      (name) => name.endsWith('.app.tar.gz.sig'),
      'macOS updater signature',
    );
    candidates = [
      await releaseAssetMetadata(dmg, 'application/x-apple-diskimage'),
      await releaseAssetMetadata(updater, 'application/gzip'),
      await releaseAssetMetadata(signature, 'application/octet-stream'),
    ];
  } else {
    const nsisRoot = path.join(bundleRoot, 'nsis');
    const updater = await exactMatches(
      nsisRoot,
      (name) => /-setup\.exe$/u.test(name),
      'Windows NSIS updater',
    );
    const signature = await exactMatches(
      nsisRoot,
      (name) => /-setup\.exe\.sig$/u.test(name),
      'Windows updater signature',
    );
    candidates = [
      await releaseAssetMetadata(updater, 'application/vnd.microsoft.portable-executable'),
      await releaseAssetMetadata(signature, 'application/octet-stream'),
    ];
  }
  const names = candidates.map(({ fileName }) => fileName);
  if (new Set(names).size !== names.length) {
    fail('current target release asset basenames must be unique');
  }
  return candidates;
}
