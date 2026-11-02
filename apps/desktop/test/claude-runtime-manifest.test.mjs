import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  inspectArchive, lockIntegrity, packageName, packageUrl, PLATFORMS,
  validateMetadata, validatePinnedManifest,
} from '../scripts/update-claude-runtime-manifest.mjs';
import { permissionArgs } from '../scripts/prepare-claude-permission-args.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const sdk = {
  version: '0.3.220', claudeCodeVersion: '2.1.220',
  optionalDependencies: Object.fromEntries(PLATFORMS.map((platform) => [packageName(platform), '0.3.220'])),
};
const lock = PLATFORMS.map((platform) => `  '${packageName(platform)}@0.3.220':\n    resolution: {integrity: ${integrity}}\n`).join('');
const fixture = () => ({
  schemaVersion: 1, sdkVersion: sdk.version, claudeVersion: sdk.claudeCodeVersion,
  minimumSystemVersion: sdk.claudeCodeVersion,
  packages: PLATFORMS.map((platform) => ({
    platform, url: packageUrl(platform, sdk.version), integrity,
    binaryPath: `package/claude${platform.startsWith('win32') ? '.exe' : ''}`,
    binarySha256: 'a'.repeat(64), binaryBytes: 200, archiveBytes: 100,
    ...(platform.startsWith('darwin') ? { minimumOsVersion: '13.0' } : {}),
  })),
});

test('recommended runtime metadata must match the exact SDK and reviewed lock integrity', () => {
  const metadata = {
    name: packageName('darwin-arm64'), version: sdk.version,
    dist: { tarball: packageUrl('darwin-arm64', sdk.version), integrity },
  };
  assert.equal(validateMetadata(metadata, 'darwin-arm64', sdk, lock), integrity);
  assert.throws(() => validateMetadata({ ...metadata, version: '0.3.221' }, 'darwin-arm64', sdk, lock), /version mismatch/);
  assert.throws(() => validateMetadata({ ...metadata, dist: { ...metadata.dist, tarball: 'https://example.org/claude.tgz' } }, 'darwin-arm64', sdk, lock), /disagrees/);
  assert.throws(() => validateMetadata({ ...metadata, dist: { ...metadata.dist, integrity: 'sha512-tampered' } }, 'darwin-arm64', sdk, lock), /disagrees/);
  assert.throws(() => lockIntegrity('', metadata.name, sdk.version), /missing/);
  assert.throws(() => packageUrl('darwin-arm64', 'latest'), /exact SDK version/);
});

test('manifest validation prevents SDK drift, missing platforms, and untrusted source changes', () => {
  assert.doesNotThrow(() => validatePinnedManifest(fixture(), sdk, lock));
  const wrongSdk = fixture();
  wrongSdk.claudeVersion = '2.1.221';
  assert.throws(() => validatePinnedManifest(wrongSdk, sdk, lock), /does not match/);
  const missing = fixture();
  missing.packages.pop();
  assert.throws(() => validatePinnedManifest(missing, sdk, lock), /Incomplete/);
  for (const change of [
    { url: 'https://example.org/claude.tgz' }, { binarySha256: '' },
    { binaryPath: '../claude' }, { archiveBytes: 2 ** 31 }, { minimumOsVersion: '10.15' },
  ]) {
    const altered = fixture();
    Object.assign(altered.packages[0], change);
    assert.throws(() => validatePinnedManifest(altered, sdk, lock), /Invalid pinned/);
  }
});

test('maintainer inspection verifies archive integrity and hashes only the original executable', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-claude-manifest-'));
  try {
    await fs.mkdir(path.join(temp, 'package'));
    const binary = Buffer.from('native executable fixture\n');
    await fs.writeFile(path.join(temp, 'package/claude'), binary);
    await fs.writeFile(path.join(temp, 'package/README.md'), 'Not included in executable digest');
    const archive = path.join(temp, 'fixture.tgz');
    execFileSync('tar', ['-czf', archive, '-C', temp, 'package']);
    const bytes = await fs.readFile(archive);
    const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    assert.deepEqual(await inspectArchive(archive, sri, 'package/claude'), {
      binarySha256: createHash('sha256').update(binary).digest('hex'),
      binaryBytes: binary.length, archiveBytes: bytes.length,
    });
    await assert.rejects(inspectArchive(archive, integrity, 'package/claude'), /integrity mismatch/);
    await assert.rejects(inspectArchive(archive, sri, '../claude'), /Unexpected native executable path/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('checked-in recommended downloads match the installed locked SDK', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'apps/desktop/src-tauri/resources/claude-runtime-manifest.json'), 'utf8'));
  const installedSdk = JSON.parse(await fs.readFile(path.join(root, 'packages/native-runtime-helper/node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
  const lockText = await fs.readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  assert.doesNotThrow(() => validatePinnedManifest(manifest, installedSdk, lockText));
});

test('Desktop direct launches preserve core CLI permission allow and deny arguments', async () => {
  const pinned = JSON.parse(await fs.readFile(path.join(root, 'apps/desktop/src-tauri/resources/claude-permission-args.json'), 'utf8'));
  assert.deepEqual(pinned, permissionArgs);
  assert.deepEqual(pinned.readonly.slice(0, 2), ['--permission-mode', 'plan']);
  assert.ok(pinned.readonly.includes('--disallowedTools'));
  assert.ok(pinned.readonly.includes('Write(*)'));
});
