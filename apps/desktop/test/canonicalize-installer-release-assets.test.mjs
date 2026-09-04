import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalInstallerBasename,
  canonicalizeInstallerReleaseAssets,
} from '../scripts/canonicalize-installer-release-assets.mjs';

const VERSION = '2.78.2';
const TARGETS = Object.freeze([
  {
    target: 'aarch64-apple-darwin',
    directory: 'dmg',
    source: `CCEM Desktop_${VERSION}_aarch64.dmg`,
    expected: `CCEM.Desktop_${VERSION}_aarch64.dmg`,
    signature: false,
  },
  {
    target: 'x86_64-apple-darwin',
    directory: 'dmg',
    source: `CCEM Desktop_${VERSION}_x64.dmg`,
    expected: `CCEM.Desktop_${VERSION}_x64.dmg`,
    signature: false,
  },
  {
    target: 'x86_64-pc-windows-msvc',
    directory: 'nsis',
    source: `CCEM Desktop_${VERSION}_x64-setup.exe`,
    expected: `CCEM.Desktop_${VERSION}_x64-setup.exe`,
    signature: true,
  },
]);

async function missing(candidate) {
  return fsp.lstat(candidate).then(() => false, (error) => {
    if (error?.code === 'ENOENT') return true;
    throw error;
  });
}

test('physically canonicalizes every GitHub release installer basename before payload verification', async (t) => {
  const publishedNames = new Set();
  for (const fixture of TARGETS) {
    await t.test(fixture.target, async (subtest) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-installer-name-'));
      subtest.after(() => fsp.rm(root, { recursive: true, force: true }));
      const directory = path.join(root, fixture.directory);
      await fsp.mkdir(directory, { recursive: true });
      const source = path.join(directory, fixture.source);
      await fsp.writeFile(source, `${fixture.target}:installer`);
      if (fixture.signature) await fsp.writeFile(`${source}.sig`, `${fixture.target}:signature`);

      assert.equal(
        canonicalInstallerBasename(fixture.target, VERSION),
        fixture.expected,
      );
      const first = await canonicalizeInstallerReleaseAssets({
        bundleRoot: root,
        target: fixture.target,
        version: VERSION,
      });
      const destination = path.join(directory, fixture.expected);
      assert.equal(first.changed, true);
      assert.equal(first.installerPath, destination);
      assert.equal(await fsp.readFile(destination, 'utf8'), `${fixture.target}:installer`);
      assert.equal(await missing(source), true);
      assert.doesNotMatch(path.basename(destination), /[^A-Za-z0-9._-]/u);
      publishedNames.add(path.basename(destination));
      if (fixture.signature) {
        assert.equal(first.signaturePath, `${destination}.sig`);
        assert.equal(await fsp.readFile(`${destination}.sig`, 'utf8'), `${fixture.target}:signature`);
        assert.equal(await missing(`${source}.sig`), true);
        publishedNames.add(path.basename(first.signaturePath));
      }

      const repeated = await canonicalizeInstallerReleaseAssets({
        bundleRoot: root,
        target: fixture.target,
        version: VERSION,
      });
      assert.equal(repeated.changed, false);
    });
  }
  assert.equal(publishedNames.size, 4);
});

test('fails closed on a case-folded destination collision without touching the source', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-installer-collision-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'dmg');
  await fsp.mkdir(directory, { recursive: true });
  const source = path.join(directory, `CCEM Desktop_${VERSION}_aarch64.dmg`);
  const collision = path.join(directory, `ccem.desktop_${VERSION}_AARCH64.dmg`);
  await fsp.writeFile(source, 'source-bytes');
  await fsp.writeFile(collision, 'collision-bytes');

  await assert.rejects(canonicalizeInstallerReleaseAssets({
    bundleRoot: root,
    target: 'aarch64-apple-darwin',
    version: VERSION,
  }), /target collision/u);
  assert.equal(await fsp.readFile(source, 'utf8'), 'source-bytes');
  assert.equal(await fsp.readFile(collision, 'utf8'), 'collision-bytes');
});

test('rejects a mismatched Windows installer signature before copying either file', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-installer-signature-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'nsis');
  await fsp.mkdir(directory, { recursive: true });
  const source = path.join(directory, `CCEM Desktop_${VERSION}_x64-setup.exe`);
  await fsp.writeFile(source, 'installer-bytes');
  await fsp.writeFile(path.join(directory, 'Other_x64-setup.exe.sig'), 'signature-bytes');

  await assert.rejects(canonicalizeInstallerReleaseAssets({
    bundleRoot: root,
    target: 'x86_64-pc-windows-msvc',
    version: VERSION,
  }), /signature basename must exactly match/u);
  assert.equal(await fsp.readFile(source, 'utf8'), 'installer-bytes');
  assert.equal(await missing(path.join(directory, canonicalInstallerBasename(
    'x86_64-pc-windows-msvc',
    VERSION,
  ))), true);
});
