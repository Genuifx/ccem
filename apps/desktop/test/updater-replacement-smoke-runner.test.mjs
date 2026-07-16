import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  currentCefFilesFromInventory,
  mutateUpdaterSignature,
  observeCurrentWindowsInstalledTree,
} from '../scripts/run-updater-replacement-smoke.mjs';
import {
  createWindowsInstalledTreeInventory,
} from '../scripts/windows-mode2-production-smoke-contract.mjs';

function encodedSignature() {
  const packet = Buffer.alloc(74, 7);
  packet[0] = 0x45;
  packet[1] = 0x44;
  const text = [
    'untrusted comment: signature from minisign secret key',
    packet.toString('base64'),
    'trusted comment: timestamp:1',
    Buffer.alloc(64, 9).toString('base64'),
  ].join('\n');
  return `${Buffer.from(`${text}\n`).toString('base64')}\n`;
}

test('bad-signature control mutates signed packet bytes, not the unauthenticated comment', () => {
  const positive = encodedSignature();
  const negative = mutateUpdaterSignature(positive);
  assert.notEqual(negative, positive);
  const positiveLines = Buffer.from(positive.trim(), 'base64').toString('utf8').trim().split('\n');
  const negativeLines = Buffer.from(negative.trim(), 'base64').toString('utf8').trim().split('\n');
  assert.equal(negativeLines[0], positiveLines[0]);
  assert.equal(negativeLines[2], positiveLines[2]);
  assert.equal(negativeLines[3], positiveLines[3]);
  const positivePacket = Buffer.from(positiveLines[1], 'base64');
  const negativePacket = Buffer.from(negativeLines[1], 'base64');
  assert.equal(positivePacket[10] ^ negativePacket[10], 1);
});

test('CEF expectation is derived from immutable platform inventory', () => {
  assert.deepEqual(currentCefFilesFromInventory({
    stableCefResources: { 'libcef.dll': 'a'.repeat(64) },
  }, 'windows'), { 'libcef.dll': 'a'.repeat(64) });

  const mac = currentCefFilesFromInventory({
    stableCefResources: {
      Resources: { type: 'directory' },
      Current: { type: 'symlink', target: 'Versions/A' },
      'Chromium Embedded Framework': {
        type: 'file',
        fingerprint: `ccem-macho-code-sha256-v1:${'b'.repeat(64)}`,
      },
    },
  }, 'macos');
  assert.match(mac['Chromium Embedded Framework'], /^[a-f0-9]{64}$/u);
  assert.equal(Object.keys(mac).length, 1);
});

test('Windows full installed-tree inventory accepts sidecars and rejects any extra residue file', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-cef-exact-'));
  try {
    const files = {
      'ccem-desktop.exe': Buffer.from('app'),
      'libcef.dll': Buffer.from('verified runtime'),
      'binaries/ccem-node.exe': Buffer.from('sidecar'),
      'resources/native-runtime-helper.mjs': Buffer.from('helper'),
      'uninstall.exe': Buffer.from('uninstaller'),
    };
    await fsp.mkdir(path.join(root, 'binaries'));
    await fsp.mkdir(path.join(root, 'resources'));
    for (const [relativePath, bytes] of Object.entries(files)) {
      await fsp.writeFile(path.join(root, ...relativePath.split('/')), bytes);
    }
    const expected = createWindowsInstalledTreeInventory({
      directories: ['binaries', 'resources'],
      files: Object.entries(files).map(([relativePath, bytes]) => ({
        relativePath,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })),
    });
    await observeCurrentWindowsInstalledTree(root, expected);
    await fsp.writeFile(path.join(root, 'libcef-old.dll'), 'residue');
    await assert.rejects(
      observeCurrentWindowsInstalledTree(root, expected),
      /differs from the immutable full-tree inventory/u,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
