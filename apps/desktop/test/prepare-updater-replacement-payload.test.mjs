import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareUpdaterReplacementPayload } from '../scripts/prepare-updater-replacement-payload.mjs';
import { validateUpdaterReplacementPayload } from '../scripts/updater-replacement-smoke-inputs.mjs';
import { createWindowsInstalledTreeInventory } from '../scripts/windows-mode2-production-smoke-contract.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceCommit = 'a'.repeat(40);
const appVersion = '2.58.0';

const TARGET_FIXTURES = Object.freeze({
  'aarch64-apple-darwin': Object.freeze([
    Object.freeze({ role: 'dmg', directory: 'dmg', fileName: 'CCEM_2.58.0_aarch64.dmg', bytes: 'mac-dmg' }),
    Object.freeze({ role: 'updater', directory: 'macos', fileName: 'CCEM.app.tar.gz', bytes: 'mac-updater' }),
    Object.freeze({ role: 'updaterSignature', directory: 'macos', fileName: 'CCEM.app.tar.gz.sig', bytes: 'mac-signature' }),
  ]),
  'x86_64-pc-windows-msvc': Object.freeze([
    Object.freeze({ role: 'updater', directory: 'nsis', fileName: 'CCEM_2.58.0_x64-setup.exe', bytes: 'windows-updater' }),
    Object.freeze({ role: 'updaterSignature', directory: 'nsis', fileName: 'CCEM_2.58.0_x64-setup.exe.sig', bytes: 'windows-signature' }),
  ]),
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeBundle(root, target) {
  const fixture = TARGET_FIXTURES[target];
  const bundleRoot = path.join(root, 'src-tauri', 'target', target, 'release', 'bundle');
  const artifacts = {};
  const paths = {};
  for (const record of fixture) {
    const candidate = path.join(bundleRoot, record.directory, record.fileName);
    const bytes = Buffer.from(record.bytes);
    await fsp.mkdir(path.dirname(candidate), { recursive: true });
    await fsp.writeFile(candidate, bytes);
    paths[record.role] = candidate;
    artifacts[record.role] = {
      fileName: record.fileName,
      size: bytes.length,
      sha256: sha256(bytes),
    };
  }
  const inventory = {
    schemaVersion: 3,
    platform: target,
    sourceCommit,
    appVersion,
    mode2Included: true,
    artifacts,
  };
  if (target.endsWith('pc-windows-msvc')) {
    inventory.installedTree = createWindowsInstalledTreeInventory({
      directories: [],
      files: [{
        relativePath: 'ccem-desktop.exe',
        size: 1,
        sha256: 'f'.repeat(64),
      }],
    });
  }
  return {
    paths,
    inventory,
  };
}

async function writeInventory(root, inventory) {
  const candidate = path.join(root, 'inventory.json');
  await fsp.writeFile(candidate, `${JSON.stringify(inventory, null, 2)}\n`);
  return candidate;
}

async function directoryEntries(candidate) {
  return (await fsp.readdir(candidate)).sort();
}

async function collectRelativeImportGraph(entry) {
  const pending = [path.resolve(entry)];
  const visited = new Set();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    const source = await fsp.readFile(candidate, 'utf8');
    const importPattern = /(?:\bfrom\s+|^\s*import\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/gmu;
    for (const match of source.matchAll(importPattern)) {
      if (!match[1].startsWith('.')) continue;
      pending.push(path.resolve(path.dirname(candidate), match[1]));
    }
  }
  return visited;
}

test('prepares exact tag-free updater challenge payloads for macOS and Windows', async (t) => {
  for (const target of Object.keys(TARGET_FIXTURES)) {
    await t.test(target, async (t2) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-payload-success-'));
      t2.after(() => fsp.rm(root, { recursive: true, force: true }));
      const { inventory } = await writeBundle(root, target);
      const inventoryPath = await writeInventory(root, inventory);
      const outputDir = path.join(root, 'payload');
      await fsp.mkdir(path.join(outputDir, 'assets'), { recursive: true });
      await fsp.writeFile(path.join(outputDir, 'stale.txt'), 'must disappear');
      await fsp.writeFile(path.join(outputDir, 'assets', 'stale.bin'), 'must disappear');

      const manifest = await prepareUpdaterReplacementPayload({
        desktopDir: root,
        inventoryPath,
        outputDir,
        target,
        sourceCommit,
      });

      assert.deepEqual(Object.keys(manifest), [
        'schemaVersion', 'target', 'sourceCommit', 'appVersion', 'assets',
      ]);
      assert.equal(manifest.schemaVersion, 1);
      assert.equal(manifest.target, target);
      assert.equal(manifest.sourceCommit, sourceCommit);
      assert.equal(manifest.appVersion, appVersion);
      assert.deepEqual(Object.keys(manifest.assets), ['updater', 'updaterSignature']);
      assert.equal(Object.hasOwn(manifest, 'tag'), false);
      assert.equal(Object.hasOwn(manifest, 'runId'), false);
      assert.equal(
        manifest.assets.updaterSignature.fileName,
        `${manifest.assets.updater.fileName}.sig`,
      );
      assert.deepEqual(await directoryEntries(outputDir), [
        'assets', 'inventory.json', 'payload-manifest.json',
      ]);
      assert.deepEqual(await directoryEntries(path.join(outputDir, 'assets')), [
        manifest.assets.updater.fileName,
        manifest.assets.updaterSignature.fileName,
      ].sort());
      assert.deepEqual(
        JSON.parse(await fsp.readFile(path.join(outputDir, 'inventory.json'), 'utf8')),
        inventory,
      );
      assert.deepEqual(
        JSON.parse(await fsp.readFile(path.join(outputDir, 'payload-manifest.json'), 'utf8')),
        manifest,
      );
      const consumed = await validateUpdaterReplacementPayload(
        outputDir,
        target,
        sourceCommit,
      );
      assert.deepEqual(consumed.manifest, manifest);
    });
  }
});

test('rejects updater bytes tampered after the final inventory was produced', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-payload-tamper-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = 'aarch64-apple-darwin';
  const { inventory, paths } = await writeBundle(root, target);
  const inventoryPath = await writeInventory(root, inventory);
  const outputDir = path.join(root, 'payload');
  await fsp.writeFile(paths.updater, 'tampered-after-inventory');

  await assert.rejects(
    prepareUpdaterReplacementPayload({
      desktopDir: root,
      inventoryPath,
      outputDir,
      target,
      sourceCommit,
    }),
    /updater bundle bytes do not match the final native inventory/u,
  );
  await assert.rejects(fsp.access(outputDir));
});

test('CLI prepares a challenge payload without tag or run identity inputs', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-payload-cli-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = 'x86_64-pc-windows-msvc';
  const { inventory } = await writeBundle(root, target);
  const inventoryPath = await writeInventory(root, inventory);
  const outputDir = path.join(root, 'payload');
  const result = spawnSync(process.execPath, [
    path.join(desktopDir, 'scripts', 'prepare-updater-replacement-payload.mjs'),
    '--target', target,
    '--inventory', inventoryPath,
    '--output', outputDir,
    '--source-commit', sourceCommit,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /challenge payload ready/u);
  const manifest = JSON.parse(await fsp.readFile(
    path.join(outputDir, 'payload-manifest.json'),
    'utf8',
  ));
  assert.equal(Object.hasOwn(manifest, 'tag'), false);
  assert.equal(Object.hasOwn(manifest, 'runId'), false);
  assert.equal(Object.hasOwn(manifest, 'runAttempt'), false);
});

test('fails closed on extra or missing bundle files and inventory roles', async (t) => {
  await t.test('extra updater bundle', async (t2) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-payload-extra-'));
    t2.after(() => fsp.rm(root, { recursive: true, force: true }));
    const target = 'aarch64-apple-darwin';
    const { inventory } = await writeBundle(root, target);
    const inventoryPath = await writeInventory(root, inventory);
    const extra = path.join(
      root,
      'src-tauri', 'target', target, 'release', 'bundle', 'macos', 'Duplicate.app.tar.gz',
    );
    await fsp.writeFile(extra, 'duplicate-updater');
    await assert.rejects(
      prepareUpdaterReplacementPayload({
        desktopDir: root,
        inventoryPath,
        outputDir: path.join(root, 'payload'),
        target,
        sourceCommit,
      }),
      /expected exactly one macOS updater archive; found 2/u,
    );
  });

  await t.test('missing updater signature', async (t2) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-payload-missing-'));
    t2.after(() => fsp.rm(root, { recursive: true, force: true }));
    const target = 'x86_64-pc-windows-msvc';
    const { inventory, paths } = await writeBundle(root, target);
    const inventoryPath = await writeInventory(root, inventory);
    await fsp.rm(paths.updaterSignature);
    await assert.rejects(
      prepareUpdaterReplacementPayload({
        desktopDir: root,
        inventoryPath,
        outputDir: path.join(root, 'payload'),
        target,
        sourceCommit,
      }),
      /expected exactly one Windows updater signature; found 0/u,
    );
  });

  for (const mutation of ['extra', 'missing']) {
    await t.test(`${mutation} inventory role`, async (t2) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), `ccem-updater-payload-${mutation}-role-`));
      t2.after(() => fsp.rm(root, { recursive: true, force: true }));
      const target = 'x86_64-pc-windows-msvc';
      const { inventory } = await writeBundle(root, target);
      if (mutation === 'extra') {
        inventory.artifacts.unexpected = {
          fileName: 'unexpected.bin',
          size: 1,
          sha256: '0'.repeat(64),
        };
      } else {
        delete inventory.artifacts.updaterSignature;
      }
      const inventoryPath = await writeInventory(root, inventory);
      await assert.rejects(
        prepareUpdaterReplacementPayload({
          desktopDir: root,
          inventoryPath,
          outputDir: path.join(root, 'payload'),
          target,
          sourceCommit,
        }),
        /inventory has an invalid release artifact role set/u,
      );
    });
  }
});

test('tag-free payload preparation has no GitHub release API in its local import graph', async () => {
  const entry = path.join(desktopDir, 'scripts', 'prepare-updater-replacement-payload.mjs');
  const graph = await collectRelativeImportGraph(entry);
  assert.deepEqual(
    [...graph].map((candidate) => path.basename(candidate)).sort(),
    ['prepare-updater-replacement-payload.mjs', 'release-asset-discovery.mjs'],
  );
  for (const candidate of graph) {
    const source = await fsp.readFile(candidate, 'utf8');
    assert.doesNotMatch(
      source,
      /github-draft-release-api|upload-draft-release-assets|ensure-draft-github-release|publish-draft-github-release|GITHUB_TOKEN|\bfetch\s*\(/u,
    );
  }

  const uploader = await fsp.readFile(
    path.join(desktopDir, 'scripts', 'upload-draft-release-assets.mjs'),
    'utf8',
  );
  const releasePayload = await fsp.readFile(
    path.join(desktopDir, 'scripts', 'prepare-release-payload.mjs'),
    'utf8',
  );
  assert.match(uploader, /from '\.\/release-asset-discovery\.mjs'/u);
  assert.match(releasePayload, /from '\.\/release-asset-discovery\.mjs'/u);
  assert.doesNotMatch(releasePayload, /upload-draft-release-assets\.mjs/u);
  assert.doesNotMatch(uploader, /export async function discoverTargetAssets/u);
});
