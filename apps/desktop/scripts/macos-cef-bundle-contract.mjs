import fsp from 'node:fs/promises';
import path from 'node:path';

import { macReleaseFileFingerprint } from './macos-macho-integrity.mjs';

// These are the only paths that code signing may add to the bundled framework.
// Every runtime/resource path outside this allowlist must exist in both trees
// with identical contents (or canonical Mach-O code bytes).
export const MACOS_FRAMEWORK_SIGNING_ONLY_NAMES = Object.freeze([
  '_CodeSignature',
  'CodeResources',
]);

function fail(message) {
  throw new Error(`[macos-cef-bundle-contract] ${message}`);
}

async function requireDirectory(candidate, label) {
  let stat;
  try {
    stat = await fsp.lstat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} is missing: ${candidate}`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real directory: ${candidate}`);
  }
}

function isSigningOnly(relative) {
  return relative === 'CodeResources'
    || relative === '_CodeSignature'
    || relative.startsWith('_CodeSignature/');
}

function snapshotName(target) {
  if (target === 'aarch64-apple-darwin') return 'v8_context_snapshot.arm64.bin';
  if (target === 'x86_64-apple-darwin') return 'v8_context_snapshot.x86_64.bin';
  fail(`unsupported macOS target ${target}`);
}

export function requiredMacCefFrameworkFiles(target) {
  return [
    'Chromium Embedded Framework',
    'Resources/Info.plist',
    'Resources/chrome_100_percent.pak',
    'Resources/chrome_200_percent.pak',
    'Resources/gpu_shader_cache.bin',
    'Resources/icudtl.dat',
    'Resources/resources.pak',
    'Resources/en.lproj/locale.pak',
    `Resources/${snapshotName(target)}`,
    'Libraries/libcef_sandbox.dylib',
    'Libraries/libEGL.dylib',
    'Libraries/libGLESv2.dylib',
    'Libraries/libvk_swiftshader.dylib',
    'Libraries/vk_swiftshader_icd.json',
  ];
}

export async function fingerprintMacCefFramework(root) {
  await requireDirectory(root, 'CEF framework');
  const fingerprint = Object.create(null);

  async function visit(current = '') {
    const absolute = current ? path.join(root, ...current.split('/')) : root;
    const entries = await fsp.readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = current ? `${current}/${entry.name}` : entry.name;
      if (isSigningOnly(relative)) continue;
      const candidate = path.join(root, ...relative.split('/'));
      const stat = await fsp.lstat(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        fingerprint[relative] = { type: 'directory' };
        await visit(relative);
      } else if (stat.isSymbolicLink()) {
        fingerprint[relative] = {
          type: 'symlink',
          target: await fsp.readlink(candidate),
        };
      } else if (stat.isFile()) {
        fingerprint[relative] = {
          type: 'file',
          fingerprint: await macReleaseFileFingerprint(candidate),
        };
      } else {
        fail(`unsupported framework member ${relative}`);
      }
    }
  }

  await visit();
  return fingerprint;
}

export function assertRequiredMacCefFrameworkFiles(fingerprint, target) {
  for (const relative of requiredMacCefFrameworkFiles(target)) {
    if (!Object.hasOwn(fingerprint, relative) || fingerprint[relative]?.type !== 'file') {
      fail(`CEF framework is missing required regular file ${relative}`);
    }
  }
}

function firstDifference(stage, bundled) {
  const stagePaths = Object.keys(stage);
  const bundledPaths = Object.keys(bundled);
  const missing = stagePaths.find((relative) => !Object.hasOwn(bundled, relative));
  if (missing) return `bundled framework is missing ${missing}`;
  const extra = bundledPaths.find((relative) => !Object.hasOwn(stage, relative));
  if (extra) return `bundled framework has unexpected ${extra}`;
  const changed = stagePaths.find(
    (relative) => JSON.stringify(stage[relative]) !== JSON.stringify(bundled[relative]),
  );
  if (changed) return `bundled framework member differs from stage: ${changed}`;
  return null;
}

export async function compareMacCefFrameworkTrees({ stageFramework, bundledFramework, target }) {
  const stage = await fingerprintMacCefFramework(stageFramework);
  const bundled = await fingerprintMacCefFramework(bundledFramework);
  assertRequiredMacCefFrameworkFiles(stage, target);
  assertRequiredMacCefFrameworkFiles(bundled, target);
  const difference = firstDifference(stage, bundled);
  if (difference) fail(difference);
  return bundled;
}
