import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareReleasePayload } from '../scripts/prepare-release-payload.mjs';

const target = 'x86_64-pc-windows-msvc';
const sourceCommit = 'a'.repeat(40);
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'prepare-release-payload.mjs',
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-release-payload-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const nsisRoot = path.join(
    root,
    'src-tauri', 'target', target, 'release', 'bundle', 'nsis',
  );
  await fsp.mkdir(nsisRoot, { recursive: true });
  const records = [
    ['updater', 'CCEM_2.58.0_x64-setup.exe', 'updater-bytes'],
    ['updaterSignature', 'CCEM_2.58.0_x64-setup.exe.sig', 'signature-bytes'],
  ];
  const artifacts = {};
  for (const [role, fileName, value] of records) {
    const bytes = Buffer.from(value);
    await fsp.writeFile(path.join(nsisRoot, fileName), bytes);
    artifacts[role] = { fileName, size: bytes.length, sha256: sha256(bytes) };
  }
  const inventoryPath = path.join(root, 'inventory.json');
  await fsp.writeFile(inventoryPath, `${JSON.stringify({
    schemaVersion: 3,
    platform: target,
    sourceCommit,
    appVersion: '2.58.0',
    mode2Included: true,
    artifacts,
  }, null, 2)}\n`);
  return { root, inventoryPath };
}

test('release payload binds the exact positive run attempt', async (t) => {
  const fixture = await createFixture(t);
  const outputDir = path.join(fixture.root, 'payload');
  const result = spawnSync(process.execPath, [
    scriptPath,
    '--target', target,
    '--inventory', fixture.inventoryPath,
    '--output', outputDir,
    '--run-id', '123456789',
    '--run-attempt', '7',
    '--tag', 'v2.58.0',
    '--source-commit', sourceCommit,
  ], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /immutable payload ready/u);
  const manifest = JSON.parse(await fsp.readFile(
    path.join(outputDir, 'payload-manifest.json'),
    'utf8',
  ));
  assert.equal(manifest.runId, '123456789');
  assert.equal(manifest.runAttempt, '7');
});

test('release payload rejects missing and non-positive run attempts', async (t) => {
  const fixture = await createFixture(t);
  for (const runAttempt of [undefined, '', '0', '-1', '1.0', 'abc']) {
    await assert.rejects(
      prepareReleasePayload({
        desktopDir: fixture.root,
        inventoryPath: fixture.inventoryPath,
        outputDir: path.join(fixture.root, `payload-${String(runAttempt)}`),
        target,
        runId: '123456789',
        runAttempt,
        tag: 'v2.58.0',
        sourceCommit,
      }),
      /GitHub run attempt (?:is required|must be a positive decimal string)/u,
    );
  }
});
