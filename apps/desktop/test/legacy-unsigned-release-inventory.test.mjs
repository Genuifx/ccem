import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareReleasePayload } from '../scripts/prepare-release-payload.mjs';
import { verifyReleasePayloads } from '../scripts/verify-release-payloads.mjs';
import {
  LEGACY_UNSIGNED_RELEASE_MODE,
  inspectLegacyBundleTree,
  inspectLegacyMacRelease,
  inspectLegacyWindowsRelease,
  validateLegacyUnsignedInventorySet,
} from '../scripts/verify-legacy-release-inventory.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryScript = path.join(desktopDir, 'scripts', 'verify-legacy-release-inventory.mjs');
const sourceCommit = 'a'.repeat(40);
const version = '2.78.1';
const signatureVerification = async () => ({ algorithm: 'minisign-ed25519-blake2b' });

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeArtifact(root, fileName, value = fileName) {
  const candidate = path.join(root, fileName);
  const bytes = Buffer.from(value);
  await fsp.mkdir(path.dirname(candidate), { recursive: true });
  await fsp.writeFile(candidate, bytes);
  return {
    path: candidate,
    metadata: { fileName, size: bytes.length, sha256: digest(bytes) },
  };
}

async function createMacApp(root, appVersion = version) {
  const app = path.join(root, 'CCEM Desktop.app');
  const executable = await writeArtifact(
    path.join(app, 'Contents', 'MacOS'),
    'ccem-desktop',
    'mac-executable',
  );
  await fsp.writeFile(path.join(app, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key><string>com.ccem.desktop</string>',
    `<key>CFBundleShortVersionString</key><string>${appVersion}</string>`,
    `<key>CFBundleVersion</key><string>${appVersion}</string>`,
    '<key>CFBundleExecutable</key><string>ccem-desktop</string>',
    '</dict></plist>',
  ].join('\n'));
  await writeArtifact(
    path.join(app, 'Contents', 'Resources', 'dsh-history'),
    'dsh-history-helper.mjs',
    'helper',
  );
  return { app, executable };
}

async function createMacInventory(root, target, suffix) {
  const { app, executable } = await createMacApp(path.join(root, `app-${suffix}`));
  const dmg = await writeArtifact(root, `CCEM_Desktop_${version}_${suffix}.dmg`, `dmg-${suffix}`);
  const updater = await writeArtifact(
    root,
    `CCEM_Desktop_${version}_${suffix}.app.tar.gz`,
    `updater-${suffix}`,
  );
  const updaterSignature = await writeArtifact(
    root,
    `${updater.metadata.fileName}.sig`,
    `signature-${suffix}`,
  );
  const packagedApp = {
    executable: executable.metadata,
    tree: await inspectLegacyBundleTree(app, `${suffix} packaged app`),
  };
  const options = {
    target,
    version,
    sourceCommit,
    appDir: app,
    dmgPath: dmg.path,
    updaterPath: updater.path,
    updaterSignaturePath: updaterSignature.path,
  };
  const operations = {
    verifyUpdaterSignature: signatureVerification,
    inspectUpdater: async () => packagedApp,
    inspectDmg: async () => packagedApp,
  };
  const inventory = await inspectLegacyMacRelease(options, operations);
  return {
    inventory,
    files: { dmg, updater, updaterSignature },
    verification: { options, operations, packagedApp },
  };
}

async function createWindowsInventory(root) {
  const buildExecutable = await writeArtifact(
    path.join(root, 'windows-build'),
    'ccem-desktop.exe',
    'windows-executable',
  );
  const installRoot = path.join(root, 'windows-install');
  const installedExecutable = await writeArtifact(
    installRoot,
    'ccem-desktop.exe',
    'windows-executable',
  );
  await writeArtifact(path.join(installRoot, 'resources'), 'native-runtime-helper.mjs', 'helper');
  const updater = await writeArtifact(root, `CCEM_Desktop_${version}_x64-setup.exe`, 'installer');
  const updaterSignature = await writeArtifact(root, `${updater.metadata.fileName}.sig`, 'signature-windows');
  const options = {
    target: 'x86_64-pc-windows-msvc',
    version,
    sourceCommit,
    appPath: buildExecutable.path,
    installerPath: updater.path,
    updaterSignaturePath: updaterSignature.path,
  };
  const operations = {
    verifyUpdaterSignature: signatureVerification,
    inspectInstaller: async () => ({
      executable: installedExecutable.metadata,
      tree: await inspectLegacyBundleTree(installRoot, 'Windows installer tree'),
    }),
  };
  const inventory = await inspectLegacyWindowsRelease(options, operations);
  return {
    inventory,
    files: { updater, updaterSignature },
    verification: { options, operations, buildExecutable, installedExecutable },
  };
}

async function createInventorySet(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-release-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const arm = await createMacInventory(root, 'aarch64-apple-darwin', 'aarch64');
  const intel = await createMacInventory(root, 'x86_64-apple-darwin', 'x64');
  const windows = await createWindowsInventory(root);
  return { root, items: [arm, intel, windows] };
}

test('legacy tree verifier rejects every known Mode 2 runtime path and symlinks', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-tree-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await writeArtifact(root, 'ccem-desktop', 'clean');
  await assert.doesNotReject(() => inspectLegacyBundleTree(root));

  for (const relative of [
    'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework',
    'Contents/Frameworks/ccem-desktop Helper.app/Contents/MacOS/ccem-desktop Helper',
    'Contents/Resources/third-party/cef/LICENSE.txt',
    'Resources/libcef.dll',
    'Resources/cef-windows-sandbox-artifact.json',
  ]) {
    const candidate = path.join(root, ...relative.split('/'));
    await writeArtifact(path.dirname(candidate), path.basename(candidate), 'cef');
    await assert.rejects(
      inspectLegacyBundleTree(root),
      /Mode 2\/CEF runtime path is forbidden/u,
    );
    await fsp.rm(path.join(root, relative.split('/')[0]), { recursive: true, force: true });
  }

  await fsp.symlink(path.join(root, 'ccem-desktop'), path.join(root, 'runtime-link'));
  await assert.rejects(inspectLegacyBundleTree(root), /contains a symlink/u);
});

test('legacy verifier creates and aggregates exact three-platform negative inventories', async (t) => {
  const fixture = await createInventorySet(t);
  const inventories = fixture.items.map(({ inventory }) => inventory);
  const aggregate = validateLegacyUnsignedInventorySet(inventories, version, sourceCommit);
  assert.equal(aggregate.releaseMode, LEGACY_UNSIGNED_RELEASE_MODE);
  assert.equal(aggregate.mode2Included, false);
  assert.equal(aggregate.targets.length, 3);

  assert.throws(
    () => validateLegacyUnsignedInventorySet(inventories.map((inventory, index) => (
      index === 2 ? { ...inventory, mode2Included: true } : inventory
    )), version, sourceCommit),
    /not an exact legacy unsigned/u,
  );
  assert.throws(
    () => validateLegacyUnsignedInventorySet(inventories.map((inventory, index) => (
      index === 0 ? {
        ...inventory,
        mode2Exclusion: { ...inventory.mode2Exclusion, denylistSha256: '0'.repeat(64) },
      } : inventory
    )), version, sourceCommit),
    /lacks the exact negative Mode 2 bundle proof/u,
  );

  const inventoryPaths = [];
  for (const inventory of inventories) {
    const candidate = path.join(fixture.root, `mode2-release-inventory-${inventory.platform}.json`);
    await fsp.writeFile(candidate, `${JSON.stringify(inventory, null, 2)}\n`);
    inventoryPaths.push(candidate);
  }
  const output = path.join(fixture.root, 'aggregate.json');
  const result = spawnSync(process.execPath, [
    inventoryScript,
    '--platform', 'set',
    '--version', version,
    '--source-commit', sourceCommit,
    ...inventoryPaths.flatMap((candidate) => ['--inventory', candidate]),
    '--output', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await fsp.readFile(output, 'utf8')).releaseMode, LEGACY_UNSIGNED_RELEASE_MODE);
});

test('legacy macOS verifier rejects stale executable and tree copies in updater or DMG', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-mac-binding-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const item = await createMacInventory(root, 'aarch64-apple-darwin', 'binding');
  const { options, operations, packagedApp } = item.verification;

  await assert.rejects(
    inspectLegacyMacRelease(options, {
      ...operations,
      inspectUpdater: async () => ({
        ...packagedApp,
        executable: { ...packagedApp.executable, sha256: '0'.repeat(64) },
      }),
    }),
    /updater app executable\/tree does not exactly match/u,
  );
  await assert.rejects(
    inspectLegacyMacRelease(options, {
      ...operations,
      inspectDmg: async () => ({
        ...packagedApp,
        tree: { ...packagedApp.tree, contentSetSha256: '0'.repeat(64) },
      }),
    }),
    /DMG app executable\/tree does not exactly match/u,
  );
});

test('legacy Windows verifier rejects an installer containing a stale main executable', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-windows-binding-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const item = await createWindowsInventory(root);
  const { options, operations, buildExecutable } = item.verification;

  await fsp.writeFile(buildExecutable.path, 'newer-windows-executable');
  await assert.rejects(
    inspectLegacyWindowsRelease(options, operations),
    /installed main executable does not exactly match the verified build executable/u,
  );
});

async function placeBundleAssets(desktopRoot, target, files) {
  const bundleRoot = path.join(desktopRoot, 'src-tauri', 'target', target, 'release', 'bundle');
  if (target.endsWith('apple-darwin')) {
    await fsp.mkdir(path.join(bundleRoot, 'dmg'), { recursive: true });
    await fsp.mkdir(path.join(bundleRoot, 'macos'), { recursive: true });
    await fsp.copyFile(files.dmg.path, path.join(bundleRoot, 'dmg', files.dmg.metadata.fileName));
    for (const role of ['updater', 'updaterSignature']) {
      await fsp.copyFile(files[role].path, path.join(bundleRoot, 'macos', files[role].metadata.fileName));
    }
  } else {
    await fsp.mkdir(path.join(bundleRoot, 'nsis'), { recursive: true });
    for (const role of ['updater', 'updaterSignature']) {
      await fsp.copyFile(files[role].path, path.join(bundleRoot, 'nsis', files[role].metadata.fileName));
    }
  }
}

test('legacy payload mode is explicit and remains consumable by the unified verifier', async (t) => {
  const fixture = await createInventorySet(t);
  const payloadRoot = path.join(fixture.root, 'payloads');
  const desktopRoot = path.join(fixture.root, 'desktop');
  const runId = '123456789';
  const runAttempt = '4';
  const tag = `v${version}`;
  await fsp.mkdir(payloadRoot);

  for (const item of fixture.items) {
    const { inventory, files } = item;
    await placeBundleAssets(desktopRoot, inventory.platform, files);
    const inventoryPath = path.join(fixture.root, `inventory-${inventory.platform}.json`);
    await fsp.writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
    await assert.rejects(
      prepareReleasePayload({
        desktopDir: desktopRoot,
        inventoryPath,
        outputDir: path.join(fixture.root, `rejected-${inventory.platform}`),
        target: inventory.platform,
        runId,
        runAttempt,
        tag,
        sourceCommit,
      }),
      /production/u,
    );
    const outputDir = path.join(
      payloadRoot,
      `mode2-release-payload-${runId}-${runAttempt}-${inventory.platform}`,
    );
    const manifest = await prepareReleasePayload({
      desktopDir: desktopRoot,
      inventoryPath,
      outputDir,
      target: inventory.platform,
      runId,
      runAttempt,
      tag,
      sourceCommit,
      releaseMode: LEGACY_UNSIGNED_RELEASE_MODE,
    });
    assert.equal(manifest.releaseMode, LEGACY_UNSIGNED_RELEASE_MODE);
  }

  await assert.rejects(
    verifyReleasePayloads({
      payloadRoot,
      version,
      sourceCommit,
      tag,
      runId,
      runAttempt,
      inventoryOutput: path.join(fixture.root, 'rejected-aggregate.json'),
      contractOutput: path.join(fixture.root, 'rejected-contract.json'),
    }),
    /production/u,
  );
  const { aggregateInventory, contract } = await verifyReleasePayloads({
    payloadRoot,
    version,
    sourceCommit,
    tag,
    runId,
    runAttempt,
    inventoryOutput: path.join(fixture.root, 'aggregate.json'),
    contractOutput: path.join(fixture.root, 'contract.json'),
    releaseMode: LEGACY_UNSIGNED_RELEASE_MODE,
  });
  assert.equal(aggregateInventory.releaseMode, LEGACY_UNSIGNED_RELEASE_MODE);
  assert.equal(contract.releaseMode, LEGACY_UNSIGNED_RELEASE_MODE);
  assert.equal(contract.targets.length, 3);
});
