import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalMacUpdaterBasename,
  canonicalizeMacUpdaterAssets,
} from '../scripts/canonicalize-macos-release-assets.mjs';

const TARGETS = Object.freeze([
  ['aarch64-apple-darwin', 'CCEM.Desktop_aarch64.app.tar.gz'],
  ['x86_64-apple-darwin', 'CCEM.Desktop_x64.app.tar.gz'],
]);

async function temporaryDirectory(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-macos-updater-name-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function writePair(root, updaterName = 'CCEM Desktop.app.tar.gz') {
  const updater = path.join(root, updaterName);
  const signature = `${updater}.sig`;
  await fsp.writeFile(updater, 'updater-archive-bytes');
  await fsp.writeFile(signature, 'updater-signature-bytes');
  return { updater, signature };
}

async function missing(candidate) {
  return fsp.lstat(candidate).then(() => false, (error) => {
    if (error?.code === 'ENOENT') return true;
    throw error;
  });
}

test('canonicalizes both macOS updater pairs without changing bytes and is idempotent', async (t) => {
  const releaseNames = new Set();
  for (const [target, expectedBasename] of TARGETS) {
    await t.test(target, async (subtest) => {
      const root = await temporaryDirectory(subtest);
      const source = await writePair(root);
      const updaterBytes = await fsp.readFile(source.updater);
      const signatureBytes = await fsp.readFile(source.signature);

      assert.equal(canonicalMacUpdaterBasename(target), expectedBasename);
      const result = await canonicalizeMacUpdaterAssets({ bundleDirectory: root, target });
      const updater = path.join(root, expectedBasename);
      const signature = `${updater}.sig`;
      assert.equal(result.changed, true);
      assert.equal(result.updaterPath, updater);
      assert.equal(result.signaturePath, signature);
      releaseNames.add(path.basename(result.updaterPath));
      releaseNames.add(path.basename(result.signaturePath));
      assert.deepEqual(await fsp.readFile(updater), updaterBytes);
      assert.deepEqual(await fsp.readFile(signature), signatureBytes);
      assert.equal(await missing(source.updater), true);
      assert.equal(await missing(source.signature), true);

      const repeated = await canonicalizeMacUpdaterAssets({ bundleDirectory: root, target });
      assert.equal(repeated.changed, false);
      assert.deepEqual(await fsp.readFile(updater), updaterBytes);
      assert.deepEqual(await fsp.readFile(signature), signatureBytes);
    });
  }
  assert.equal(releaseNames.size, 4, 'the two macOS targets must expose four unique release names');
});

test('rejects target collisions without touching the original updater pair', async (t) => {
  const root = await temporaryDirectory(t);
  const source = await writePair(root);
  const destination = path.join(root, canonicalMacUpdaterBasename('aarch64-apple-darwin'));
  await fsp.writeFile(destination, 'unrelated-existing-file');

  await assert.rejects(
    canonicalizeMacUpdaterAssets({
      bundleDirectory: root,
      target: 'aarch64-apple-darwin',
    }),
    /target collision/u,
  );
  assert.equal(await fsp.readFile(source.updater, 'utf8'), 'updater-archive-bytes');
  assert.equal(await fsp.readFile(source.signature, 'utf8'), 'updater-signature-bytes');
  assert.equal(await fsp.readFile(destination, 'utf8'), 'unrelated-existing-file');
});

test('rejects case-folded collisions, invalid pairs, and symlink candidates', async (t) => {
  await t.test('case-folded destination collision', async (subtest) => {
    const root = await temporaryDirectory(subtest);
    await writePair(root);
    await fsp.writeFile(path.join(root, 'ccem.desktop_AARCH64.app.tar.gz'), 'collision');
    await assert.rejects(
      canonicalizeMacUpdaterAssets({ bundleDirectory: root, target: 'aarch64-apple-darwin' }),
      /target collision/u,
    );
  });

  await t.test('orphan signature', async (subtest) => {
    const root = await temporaryDirectory(subtest);
    await fsp.writeFile(path.join(root, 'CCEM Desktop.app.tar.gz.sig'), 'signature');
    await assert.rejects(
      canonicalizeMacUpdaterAssets({ bundleDirectory: root, target: 'aarch64-apple-darwin' }),
      /exactly one macOS updater archive/u,
    );
  });

  await t.test('mismatched signature', async (subtest) => {
    const root = await temporaryDirectory(subtest);
    await fsp.writeFile(path.join(root, 'CCEM Desktop.app.tar.gz'), 'updater');
    await fsp.writeFile(path.join(root, 'Other.app.tar.gz.sig'), 'signature');
    await assert.rejects(
      canonicalizeMacUpdaterAssets({ bundleDirectory: root, target: 'aarch64-apple-darwin' }),
      /signature basename must exactly match/u,
    );
  });

  await t.test('multiple updater archives', async (subtest) => {
    const root = await temporaryDirectory(subtest);
    await writePair(root);
    await writePair(root, 'Other.app.tar.gz');
    await assert.rejects(
      canonicalizeMacUpdaterAssets({ bundleDirectory: root, target: 'aarch64-apple-darwin' }),
      /exactly one macOS updater archive/u,
    );
  });

  await t.test('symlink updater', async (subtest) => {
    const root = await temporaryDirectory(subtest);
    const real = path.join(root, 'archive.bin');
    await fsp.writeFile(real, 'updater');
    await fsp.symlink(real, path.join(root, 'CCEM Desktop.app.tar.gz'));
    await fsp.writeFile(path.join(root, 'CCEM Desktop.app.tar.gz.sig'), 'signature');
    await assert.rejects(
      canonicalizeMacUpdaterAssets({ bundleDirectory: root, target: 'aarch64-apple-darwin' }),
      /regular non-symlink file/u,
    );
  });
});

test('rolls back a partial pair copy and leaves no canonical destination', async (t) => {
  const root = await temporaryDirectory(t);
  const source = await writePair(root);
  let copies = 0;
  await assert.rejects(
    canonicalizeMacUpdaterAssets({
      bundleDirectory: root,
      target: 'aarch64-apple-darwin',
    }, {
      copyFile: async (...args) => {
        copies += 1;
        if (copies === 2) throw new Error('injected second-copy failure');
        return fsp.copyFile(...args);
      },
    }),
    /injected second-copy failure/u,
  );
  assert.equal(await fsp.readFile(source.updater, 'utf8'), 'updater-archive-bytes');
  assert.equal(await fsp.readFile(source.signature, 'utf8'), 'updater-signature-bytes');
  const destination = path.join(root, canonicalMacUpdaterBasename('aarch64-apple-darwin'));
  assert.equal(await missing(destination), true);
  assert.equal(await missing(`${destination}.sig`), true);
});

test('restores the original pair when removing the second source fails', async (t) => {
  const root = await temporaryDirectory(t);
  const source = await writePair(root);
  let injected = false;
  await assert.rejects(
    canonicalizeMacUpdaterAssets({
      bundleDirectory: root,
      target: 'aarch64-apple-darwin',
    }, {
      unlink: async (candidate) => {
        if (!injected && candidate === source.signature) {
          injected = true;
          throw new Error('injected signature-removal failure');
        }
        return fsp.unlink(candidate);
      },
      copyFile: (sourcePath, destinationPath, flags = fsConstants.COPYFILE_EXCL) => (
        fsp.copyFile(sourcePath, destinationPath, flags)
      ),
    }),
    /injected signature-removal failure/u,
  );
  assert.equal(await fsp.readFile(source.updater, 'utf8'), 'updater-archive-bytes');
  assert.equal(await fsp.readFile(source.signature, 'utf8'), 'updater-signature-bytes');
  const destination = path.join(root, canonicalMacUpdaterBasename('aarch64-apple-darwin'));
  assert.equal(await missing(destination), true);
  assert.equal(await missing(`${destination}.sig`), true);
});
