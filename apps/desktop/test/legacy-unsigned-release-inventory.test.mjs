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
  inspectLegacyMacApp,
  LEGACY_MAC_PLATFORM_VERIFICATION,
  LEGACY_MAC_SIGNATURE_VERIFICATION,
  inspectLegacyWindowsRelease,
  validateLegacyUnsignedInventorySet,
} from '../scripts/verify-legacy-release-inventory.mjs';

import {
  CEF_FULL_VERSION, CEF_LICENSE_SHA256, CEF_LICENSE_SOURCE_PATH,
  CEF_LICENSE_SOURCE_COMMIT, CEF_LEGAL_DIRECTORY, cefArchiveSpec,
} from '../scripts/cef-runtime-contract.mjs';
import {
  CEF_SAFE_STORAGE_BRANDING_METHOD, CEF_UNBRANDED_SAFE_STORAGE_SERVICE,
  CCEM_SAFE_STORAGE_SERVICE,
} from '../scripts/cef-macos-safe-storage-branding.mjs';
import { FRAMEWORK_NAME, HELPER_SPECS, STAGE_MANIFEST_NAME } from '../scripts/stage-cef-macos.mjs';
import { requiredMacCefFrameworkFiles } from '../scripts/macos-cef-bundle-contract.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryScript = path.join(desktopDir, 'scripts', 'verify-legacy-release-inventory.mjs');
const sourceCommit = 'a'.repeat(40);
const version = '2.78.1';
const signatureVerification = async () => ({ algorithm: 'minisign-ed25519-blake2b' });
// These fixtures exercise real chmod/stat execute bits; Windows does not expose them.
const macFilesystemFixture = { skip: process.platform === 'win32' };

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

function createSignedMachOFixture({
  codeByte = 0x42,
  signature = Buffer.alloc(32, 0xa5),
} = {}) {
  const signatureOffset = 128;
  const bytes = Buffer.alloc(signatureOffset + signature.length);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(6, 12);
  bytes.writeUInt32LE(2, 16);
  bytes.writeUInt32LE(88, 20);
  const linkedit = 32;
  bytes.writeUInt32LE(0x19, linkedit);
  bytes.writeUInt32LE(72, linkedit + 4);
  bytes.write('__LINKEDIT', linkedit + 8, 'ascii');
  bytes.writeBigUInt64LE(0x1000n, linkedit + 24);
  bytes.writeBigUInt64LE(BigInt(signature.length + 0x1000), linkedit + 32);
  bytes.writeBigUInt64LE(120n, linkedit + 40);
  bytes.writeBigUInt64LE(BigInt(signature.length + 8), linkedit + 48);
  bytes.writeUInt32LE(1, linkedit + 56);
  bytes.writeUInt32LE(1, linkedit + 60);
  const codeSignature = linkedit + 72;
  bytes.writeUInt32LE(0x1d, codeSignature);
  bytes.writeUInt32LE(16, codeSignature + 4);
  bytes.writeUInt32LE(signatureOffset, codeSignature + 8);
  bytes.writeUInt32LE(signature.length, codeSignature + 12);
  bytes.fill(codeByte, 120, signatureOffset);
  signature.copy(bytes, signatureOffset);
  return bytes;
}

async function createMacApp(root, target = 'aarch64-apple-darwin', appVersion = version) {
  const app = path.join(root, 'CCEM Desktop.app');
  const executable = await writeArtifact(
    path.join(app, 'Contents', 'MacOS'),
    'ccem-desktop',
    createSignedMachOFixture(),
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
  await fsp.chmod(executable.path, 0o755);
  const frameworks = path.join(app, 'Contents', 'Frameworks');
  const framework = path.join(frameworks, FRAMEWORK_NAME);
  for (const relative of requiredMacCefFrameworkFiles(target)) {
    const binary = relative === 'Chromium Embedded Framework' || relative.endsWith('.dylib');
    const record = await writeArtifact(framework, relative, binary ? createSignedMachOFixture() : `CEF:${relative}`);
    if (binary) await fsp.chmod(record.path, 0o755);
  }
  for (const spec of HELPER_SPECS) {
    const helperContents = path.join(frameworks, spec.bundleName, 'Contents');
    const helper = await writeArtifact(path.join(helperContents, 'MacOS'), spec.executableName, createSignedMachOFixture());
    await fsp.chmod(helper.path, 0o755);
    await fsp.writeFile(path.join(helperContents, 'Info.plist'), `<plist><dict>
<key>CFBundleIdentifier</key><string>${spec.bundleIdentifier}</string>
<key>CFBundleExecutable</key><string>${spec.executableName}</string>
<key>CFBundleShortVersionString</key><string>${appVersion}</string>
<key>CFBundleVersion</key><string>${appVersion}</string>
</dict></plist>`);
  }
  const legalRoot = path.join(app, 'Contents', 'Resources', CEF_LEGAL_DIRECTORY);
  await writeArtifact(legalRoot, 'CREDITS.html', 'fixture credits');
  await fsp.copyFile(CEF_LICENSE_SOURCE_PATH, path.join(legalRoot, 'LICENSE.txt'));
  const archive = cefArchiveSpec(target);
  const legal = {
    directory: CEF_LEGAL_DIRECTORY,
    license: { file: 'LICENSE.txt', sourceCommit: CEF_LICENSE_SOURCE_COMMIT, sha256: CEF_LICENSE_SHA256 },
    credits: { file: 'CREDITS.html', archiveName: archive.name, archiveSha1: archive.sha1, sha256: archive.creditsSha256 },
  };
  const stage = path.join(root, 'stage');
  await fsp.cp(frameworks, stage, { recursive: true });
  await fsp.cp(path.join(app, 'Contents', 'Resources', 'third-party'), path.join(stage, 'third-party'), { recursive: true });
  const branding = {
    schemaVersion: 1, method: CEF_SAFE_STORAGE_BRANDING_METHOD,
    sourceService: CEF_UNBRANDED_SAFE_STORAGE_SERVICE, service: CCEM_SAFE_STORAGE_SERVICE,
    byteOffset: archive.safeStorageByteOffset,
    byteLength: Buffer.byteLength(CEF_UNBRANDED_SAFE_STORAGE_SERVICE),
    sourceExecutableSha256: archive.frameworkExecutableSha256,
    brandedExecutableSha256: archive.brandedFrameworkExecutableSha256,
  };
  await fsp.writeFile(path.join(stage, STAGE_MANIFEST_NAME), JSON.stringify({
    schemaVersion: 1,
    build: { target, profile: 'release' },
    cef: {
      runtimeVersion: CEF_FULL_VERSION,
      sourceFrameworkPinned: true,
      sourceFrameworkExecutableSha256: archive.frameworkExecutableSha256,
      sourceFrameworkTreeSha256: archive.frameworkTreeSha256,
      brandedFrameworkTreeSha256: archive.brandedFrameworkTreeSha256,
      safeStorageBranding: branding,
    },
    legal,
  }));
  // Native signature verification and the large pinned upstream CEF bytes are
  // substituted at the operation boundary. Layout, file bytes, modes, Mach-O
  // parsing, and comparisons still run against real filesystem fixtures.
  const appOperations = {
    verifyAppSignature: async () => ({ verification: LEGACY_MAC_SIGNATURE_VERIFICATION }),
    verifySafeStorageBranding: async () => {},
    inspectCefLegal: async () => legal,
  };
  return { app, executable, stage, appOperations };
}

async function createMacInventory(root, target, suffix) {
  const { app, stage, appOperations } = await createMacApp(path.join(root, `app-${suffix}`), target);
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
  const packagedApp = await inspectLegacyMacApp(app, version, target, stage, appOperations);
  const options = {
    target,
    version,
    sourceCommit,
    appDir: app,
    stageDir: stage,
    dmgPath: dmg.path,
    updaterPath: updater.path,
    updaterSignaturePath: updaterSignature.path,
  };
  const operations = {
    ...appOperations,
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

test('legacy verifier includes macOS CEF while keeping Windows runtime excluded', macFilesystemFixture, async (t) => {
  const fixture = await createInventorySet(t);
  const inventories = fixture.items.map(({ inventory }) => inventory);
  const aggregate = validateLegacyUnsignedInventorySet(inventories, version, sourceCommit);
  assert.equal(aggregate.releaseMode, LEGACY_UNSIGNED_RELEASE_MODE);
  assert.equal(aggregate.mode2Included, false);
  assert.equal(aggregate.targets.length, 3);
  assert.deepEqual(aggregate.mode2ByTarget, {
    'aarch64-apple-darwin': true, 'x86_64-apple-darwin': true, 'x86_64-pc-windows-msvc': false,
  });
  assert.equal(inventories[0].platformVerification, LEGACY_MAC_PLATFORM_VERIFICATION);
  assert.equal(inventories[0].mode2Exclusion, undefined);
  for (const mutation of [
    { mode2Included: false, cefRuntimeVersion: null },
    { helperBundles: [] },
    { stableCefResources: {} },
    { cefBundle: { ...inventories[0].cefBundle, signatureVerification: 'unchecked' } },
    { cefBundle: { ...inventories[0].cefBundle, inspectedContainers: {
      ...inventories[0].cefBundle.inspectedContainers,
      updater: { ...inventories[0].cefBundle.inspectedContainers.updater, contentSetSha256: '0'.repeat(64) },
    } } },
  ]) {
    assert.throws(() => validateLegacyUnsignedInventorySet([
      { ...inventories[0], ...mutation }, ...inventories.slice(1),
    ], version, sourceCommit), /complete CEF|required regular file|content does not match/u);
  }


  assert.throws(
    () => validateLegacyUnsignedInventorySet(inventories.map((inventory, index) => (
      index === 2 ? { ...inventory, mode2Included: true } : inventory
    )), version, sourceCommit),
    /not an exact legacy unsigned/u,
  );
  assert.throws(
    () => validateLegacyUnsignedInventorySet(inventories.map((inventory, index) => (
      index === 2 ? {
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

test('legacy macOS verifier rejects missing framework, helpers, resources, and legal files', macFilesystemFixture, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-cef-required-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const cases = [
    `Contents/Frameworks/${FRAMEWORK_NAME}`,
    ...HELPER_SPECS.map(({ bundleName }) => `Contents/Frameworks/${bundleName}`),
    `Contents/Frameworks/${FRAMEWORK_NAME}/Resources/resources.pak`,
    `Contents/Frameworks/${FRAMEWORK_NAME}/Resources/v8_context_snapshot.arm64.bin`,
    `Contents/Frameworks/${FRAMEWORK_NAME}/Libraries/libcef_sandbox.dylib`,
    `Contents/Frameworks/${HELPER_SPECS[0].bundleName}/Contents/MacOS/${HELPER_SPECS[0].executableName}`,
    `Contents/Resources/${CEF_LEGAL_DIRECTORY}/LICENSE.txt`,
    `Contents/Resources/${CEF_LEGAL_DIRECTORY}/CREDITS.html`,
  ];
  for (const [index, relative] of cases.entries()) {
    const { verification: { options, operations } } = await createMacInventory(root, 'aarch64-apple-darwin', `missing-${index}`);
    await fsp.rm(path.join(options.appDir, relative), { recursive: true, force: true });
    await assert.rejects(
      inspectLegacyMacRelease(options, operations),
      /missing|Helper.app inventory mismatch/u,
      `must reject removed ${relative}`,
    );
  }
});

test('legacy macOS verifier rejects changed or additional CEF files and non-executable helpers', macFilesystemFixture, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-cef-content-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const item = await createMacInventory(root, 'aarch64-apple-darwin', 'content');
  const { options, operations } = item.verification;
  const framework = path.join(options.appDir, 'Contents', 'Frameworks', FRAMEWORK_NAME);
  const resource = path.join(framework, 'Resources', 'resources.pak');
  const original = await fsp.readFile(resource);
  await fsp.writeFile(resource, 'wrong-resource-bytes');
  await assert.rejects(inspectLegacyMacRelease(options, operations), /framework member differs from stage/u);
  await fsp.writeFile(resource, original);
  const extra = path.join(framework, 'Resources', 'stale.pak');
  await fsp.writeFile(extra, 'stale');
  await assert.rejects(inspectLegacyMacRelease(options, operations), /unexpected Resources\/stale.pak/u);
  await fsp.rm(extra);
  const helper = path.join(options.appDir, 'Contents', 'Frameworks', HELPER_SPECS[0].bundleName,
    'Contents', 'MacOS', HELPER_SPECS[0].executableName);
  await fsp.chmod(helper, 0o644);
  await assert.rejects(inspectLegacyMacRelease(options, operations), /not executable/u);
  await fsp.chmod(helper, 0o755);
  await fsp.writeFile(helper, createSignedMachOFixture({ codeByte: 0x43 }));
  await assert.rejects(inspectLegacyMacRelease(options, operations), /executable differs from the pinned stage/u);
});

test('legacy macOS verifier requires native ad-hoc verification and pinned legal bytes', macFilesystemFixture, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-cef-native-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const { verification: { options, operations } } = await createMacInventory(root, 'aarch64-apple-darwin', 'native-proof');
  await assert.rejects(inspectLegacyMacRelease(options, {
    ...operations, verifyAppSignature: async () => ({ verification: 'unchecked' }),
  }), /lacks native ad-hoc signature verification/u);
  await assert.rejects(inspectLegacyMacRelease(options, {
    ...operations, verifyAppSignature: async () => { throw new Error('native signature invalid'); },
  }), /native signature invalid/u);
  await assert.rejects(inspectLegacyMacRelease(options, {
    ...operations, inspectCefLegal: undefined,
  }), /CREDITS.html does not match the verified/u);
  await assert.rejects(inspectLegacyMacRelease(options, {
    ...operations, verifySafeStorageBranding: undefined,
  }), /does not match its CCEM Safe Storage branding evidence/u);
});

test('legacy macOS verifier rejects stale executable and tree copies in updater or DMG', macFilesystemFixture, async (t) => {
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

test('legacy macOS verifier inspects the native Tauri updater before cleanup', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-native-updater-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const item = await createMacInventory(root, 'aarch64-apple-darwin', 'native');
  const { options, operations } = item.verification;
  const archived = spawnSync('/usr/bin/tar', [
    '-czf', options.updaterPath,
    '-C', path.dirname(options.appDir),
    path.basename(options.appDir),
  ], { encoding: 'utf8' });
  assert.equal(archived.status, 0, archived.stderr);
  const verifiedApps = [];
  await assert.doesNotReject(() => inspectLegacyMacRelease(options, {
    ...operations,
    inspectUpdater: undefined,
    verifyAppSignature: async (appDir) => {
      verifiedApps.push(appDir);
      return { verification: LEGACY_MAC_SIGNATURE_VERIFICATION };
    },
  }));
  assert.equal(verifiedApps.length, 2);
  assert.notEqual(verifiedApps[0], verifiedApps[1]);
  await assert.rejects(fsp.stat(verifiedApps[1]), { code: 'ENOENT' });
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

test('legacy payload mode is explicit and remains consumable by the unified verifier', macFilesystemFixture, async (t) => {
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
    if (inventory.platform.endsWith('apple-darwin')) {
      const oldInventory = { ...inventory, mode2Included: false, cefRuntimeVersion: null, helperBundles: [], stableCefResources: {} };
      await fsp.writeFile(inventoryPath, JSON.stringify(oldInventory));
      await assert.rejects(prepareReleasePayload({
        desktopDir: desktopRoot, inventoryPath,
        outputDir: path.join(fixture.root, `old-rejected-${inventory.platform}`),
        target: inventory.platform, runId, runAttempt, tag, sourceCommit,
        releaseMode: LEGACY_UNSIGNED_RELEASE_MODE,
      }), /exact legacy-unsigned target/u);
      await fsp.writeFile(inventoryPath, JSON.stringify({ ...inventory, helperBundles: [] }));
      await assert.rejects(prepareReleasePayload({
        desktopDir: desktopRoot, inventoryPath,
        outputDir: path.join(fixture.root, `incomplete-rejected-${inventory.platform}`),
        target: inventory.platform, runId, runAttempt, tag, sourceCommit,
        releaseMode: LEGACY_UNSIGNED_RELEASE_MODE,
      }), /complete CEF/u);
    }

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
  const macInventoryPath = path.join(payloadRoot,
    `mode2-release-payload-${runId}-${runAttempt}-aarch64-apple-darwin`, 'inventory.json');
  const macInventory = JSON.parse(await fsp.readFile(macInventoryPath, 'utf8'));
  for (const mutation of [{ mode2Included: false, cefRuntimeVersion: null }, { helperBundles: [] }]) {
    await fsp.writeFile(macInventoryPath, JSON.stringify({ ...macInventory, ...mutation }));
    await assert.rejects(verifyReleasePayloads({
      payloadRoot, version, sourceCommit, tag, runId, runAttempt,
      inventoryOutput: path.join(fixture.root, 'bad-aggregate.json'),
      contractOutput: path.join(fixture.root, 'bad-contract.json'),
      releaseMode: LEGACY_UNSIGNED_RELEASE_MODE,
    }), /does not bind the current legacy-unsigned|complete CEF/u);
  }

});
