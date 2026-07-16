import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertNoForbiddenChildEnvironment,
  assertUpdaterReplacementSmokeAuthorization,
  createUpdaterReplacementChildEnvironment,
  readAndVerifyStage,
  scanNoFollowTree,
  updaterReplacementPathForEvidence,
  updaterReplacementPathIsInside,
  updaterReplacementPathsEqual,
  writeHarnessStage,
} from '../scripts/updater-replacement-smoke-runner-core.mjs';

const SHA = 'a'.repeat(40);
const NONCE = 'b'.repeat(64);

function windowsEnvironment() {
  return {
    GITHUB_ACTIONS: 'true',
    CI: 'true',
    RUNNER_OS: 'Windows',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_SHA: SHA,
    CCEM_UPDATER_REPLACEMENT_SMOKE_ALLOW: '1',
  };
}

test('authorization is CI-only and explicitly gated', () => {
  assert.equal(assertUpdaterReplacementSmokeAuthorization(windowsEnvironment(), 'win32'), 'Windows');
  assert.throws(
    () => assertUpdaterReplacementSmokeAuthorization({ ...windowsEnvironment(), CI: 'false' }, 'win32'),
    /explicit GitHub Actions platform gate/u,
  );
  assert.throws(
    () => assertUpdaterReplacementSmokeAuthorization(windowsEnvironment(), 'darwin'),
    /explicit GitHub Actions platform gate/u,
  );
});

test('child environment is an allowlist and never inherits release credentials', () => {
  const environment = {
    ...windowsEnvironment(),
    PATH: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    GITHUB_TOKEN: 'secret',
    ACTIONS_RUNTIME_TOKEN: 'secret',
    TAURI_SIGNING_PRIVATE_KEY: 'secret',
    APPLE_CERTIFICATE_PASSWORD: 'secret',
    CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ALLOW: '1',
    CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_KEYCHAIN_PATH: '/private/tmp/secret.keychain-db',
    RANDOM_UNRELATED_VALUE: 'secret',
  };
  const child = createUpdaterReplacementChildEnvironment(
    environment,
    { CCEM_UPDATER_REPLACEMENT_SMOKE_ALLOW: '1', CCEM_SMOKE_CONFIG: 'C:\\Temp\\config.json' },
    'win32',
  );
  assert.equal(child.PATH, environment.PATH);
  assert.equal(child.CCEM_SMOKE_CONFIG, 'C:\\Temp\\config.json');
  assert.equal(child.GITHUB_TOKEN, undefined);
  assert.equal(child.ACTIONS_RUNTIME_TOKEN, undefined);
  assert.equal(child.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(child.APPLE_CERTIFICATE_PASSWORD, undefined);
  assert.equal(child.CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ALLOW, undefined);
  assert.equal(child.CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_KEYCHAIN_PATH, undefined);
  assert.equal(child.RANDOM_UNRELATED_VALUE, undefined);
  assert.equal(assertNoForbiddenChildEnvironment(child), true);
  assert.throws(
    () => createUpdaterReplacementChildEnvironment(environment, { GITHUB_TOKEN: 'x' }, 'win32'),
    /forbidden child environment/u,
  );
});

test('Windows path identity treats canonical verbatim, drive, UNC, and CIM spellings correctly', () => {
  assert.equal(
    updaterReplacementPathForEvidence('\\\\?\\D:\\runner\\fixture\\ccem-desktop.exe', 'win32'),
    'D:\\runner\\fixture\\ccem-desktop.exe',
  );
  assert.equal(
    updaterReplacementPathForEvidence('\\\\?\\UNC\\server\\share\\CCEM\\ccem-desktop.exe', 'windows'),
    '\\\\server\\share\\CCEM\\ccem-desktop.exe',
  );
  assert.equal(
    updaterReplacementPathsEqual(
      '\\\\?\\D:\\RUNNER\\fixture\\ccem-desktop.exe',
      'd:\\runner\\fixture\\ccem-desktop.exe',
      'win32',
    ),
    true,
  );
  assert.equal(
    updaterReplacementPathIsInside(
      '\\\\?\\D:\\runner\\fixture\\children\\helper.exe',
      'd:\\RUNNER\\fixture',
      'windows',
    ),
    true,
  );
  assert.equal(
    updaterReplacementPathIsInside(
      'D:\\runner\\fixture-escape\\helper.exe',
      'D:\\runner\\fixture',
      'windows',
    ),
    false,
  );
});

test('no-follow tree scanner hashes every entry and records links without following them', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-tree-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'nested'));
  await fsp.writeFile(path.join(root, 'nested', 'runtime.bin'), 'current');
  await fsp.symlink(path.join(root, 'nested'), path.join(root, 'escape'));

  const first = await scanNoFollowTree(root);
  const second = await scanNoFollowTree(root);
  assert.equal(first.treeSha256, second.treeSha256);
  assert.deepEqual(first.linkPaths, ['escape']);
  assert.deepEqual(first.unsupportedEntries, []);
  assert.deepEqual(first.entries.map((entry) => entry.relativePath), [
    'escape', 'nested', 'nested/runtime.bin',
  ]);
  await fsp.writeFile(path.join(root, 'nested', 'runtime.bin'), 'changed');
  assert.notEqual((await scanNoFollowTree(root)).treeSha256, first.treeSha256);
});

test('harness stage detail is retained and its receipt hash is independently recomputed', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-stage-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const identity = {
    processIdentitySha256: 'c'.repeat(64),
  };
  await writeHarnessStage({
    sharedRoot: root,
    sequence: 5,
    name: 'oldExit',
    identity,
    contextSha256: 'd'.repeat(64),
    detail: { exited: true, challengeNonce: NONCE },
    previousReceipt: {
      bootMonotonicMs: 1,
      wallClockUtc: '2026-07-16T00:00:00.000Z',
      receiptSha256: 'e'.repeat(64),
    },
  });
  const verified = await readAndVerifyStage(root, 5, 'oldExit');
  assert.deepEqual(verified.detail, { exited: true, challengeNonce: NONCE });

  const detailPath = path.join(root, 'stage-05-oldExit.detail.json');
  await fsp.writeFile(detailPath, `${JSON.stringify({ exited: false })}\n`);
  await assert.rejects(() => readAndVerifyStage(root, 5, 'oldExit'), /does not hash/u);
});
