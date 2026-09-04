import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODESIGN_PATH,
  RELEASE_INVENTORY_SCHEMA_VERSION,
  SPCTL_PATH,
  XCRUN_PATH,
  assertNotaryAccepted,
  bindFinalDmgArtifact,
  createDmgNotarizationPlan,
  createMacVerificationPlan,
  validateInventoryFileBindings,
  validateInventorySet,
} from '../scripts/verify-mode2-release-inventory.mjs';
import {
  WINDOWS_MAIN_EXECUTABLE_NAME,
  WINDOWS_CEF_SOURCE_PIN,
  WINDOWS_SANDBOX_CLIENT_NAME,
  WINDOWS_SANDBOX_ENTRY_POINT,
} from '../scripts/stage-cef-windows.mjs';
import { CEF_FULL_VERSION } from '../scripts/stage-cef-macos.mjs';
import { verifyTauriUpdaterSignatureBytes } from '../scripts/verify-tauri-updater-signature.mjs';
import { canonicalMachOHash } from '../scripts/macos-macho-integrity.mjs';
import { requireDraftGithubRelease } from '../scripts/require-draft-github-release.mjs';
import {
  UPDATER_REPLACEMENT_PROOF_CLASS,
  UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
  UPDATER_REPLACEMENT_STAGES,
} from '../scripts/updater-replacement-smoke-contract.mjs';
import {
  WINDOWS_MODE2_CHROMIUM_VERSION,
  WINDOWS_MODE2_REQUIRED_PROCESS_TYPES,
  WINDOWS_MODE2_REQUIRED_STAGES,
  WINDOWS_MODE2_SANDBOX_PROFILE,
  WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
  createWindowsInstalledTreeInventory,
  createWindowsRuntimeInventoryFingerprint,
  hashWindowsMode2SmokeJson,
} from '../scripts/windows-mode2-production-smoke-contract.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(desktopDir, '..', '..');
const windowsStageScript = path.join(desktopDir, 'scripts', 'stage-cef-windows.mjs');
const inventoryScript = path.join(desktopDir, 'scripts', 'verify-mode2-release-inventory.mjs');

function normalizeRepoText(source) {
  return source.replace(/\r\n?/g, '\n');
}

async function readRepoText(filePath) {
  return normalizeRepoText(await fs.readFile(filePath, 'utf8'));
}

test('repo source reader normalizes CRLF and lone CR boundaries', () => {
  assert.equal(normalizeRepoText('before\r\nmarker\rafter'), 'before\nmarker\nafter');
});

const sourceCommit = 'a'.repeat(40);
const repository = 'Genuifx/ccem';
const workflowRef =
  `${repository}/.github/workflows/release-desktop.yml@refs/tags/v2.53.0`;
const producerWorkflowRef =
  `${repository}/.github/workflows/mode2-signed-producer.yml@refs/tags/v2.53.0`;
const job = 'build-desktop';
const safeStorageBranding = Object.freeze({
  schemaVersion: 1,
  method: 'unique-null-padded-literal-replacement-v1',
  sourceService: 'Chromium Safe Storage',
  service: 'CCEM Safe Storage',
  byteOffset: 1024,
  byteLength: Buffer.byteLength('Chromium Safe Storage'),
  sourceExecutableSha256: '1'.repeat(64),
  brandedExecutableSha256: '2'.repeat(64),
  signedExecutableSha256: '3'.repeat(64),
});

function macosSafeStorageRuntimeAttestation(platform, executableSha256, attestationSeed) {
  return {
    schemaVersion: 2,
    platform,
    status: 'passed',
    sourceCommit,
    appVersion: '2.53.0',
    runId: '1234',
    runAttempt: '2',
    repository,
    workflowRef,
    producerWorkflowRef,
    job,
    attestationSha256: attestationSeed.repeat(64),
    executableSha256,
    frameworkSha256: safeStorageBranding.signedExecutableSha256,
    safeStorageService: 'CCEM Safe Storage',
    credentialStore: 'macos-system-keychain-v2',
    scenarios: ['clean', 'generic-conflict'],
    launchCount: 4,
    cleanKeychainVerified: true,
    genericConflictIsolationVerified: true,
    cookiePersistenceVerified: true,
    productionBehaviorVerified: true,
    semanticLaunchCount: 4,
    effectFenceVerified: true,
    profileIsolationVerified: true,
    screenshotArtifactsVerified: true,
    keychainStateRestored: true,
    cleanupVerified: true,
  };
}

function updaterReplacementAttestation(
  platform,
  executableSha256,
  updaterSha256,
  signatureSha256,
  installedTree = null,
) {
  const macos = platform.endsWith('apple-darwin');
  const summary = {
    schemaVersion: UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
    proofClass: UPDATER_REPLACEMENT_PROOF_CLASS,
    platform: macos ? 'macos' : 'windows',
    target: platform,
    runId: '1234',
    runAttempt: '2',
    repository,
    workflowRef,
    producerWorkflowRef,
    job,
    challengeNonce: '0'.repeat(64),
    sourceCommit,
    previousTag: 'v2.52.1',
    previousSourceCommit: 'b'.repeat(40),
    previousVersion: '2.52.1',
    previousExecutableSha256: '1'.repeat(64),
    instrumentationPatchSha256: '2'.repeat(64),
    previousEmbeddedUpdaterPublicKeySha256: '3'.repeat(64),
    currentVersion: '2.53.0',
    currentExecutableSha256: executableSha256,
    updaterPublicKeySha256: '4'.repeat(64),
    updaterArtifactSha256: updaterSha256,
    updaterSignatureSha256: signatureSha256,
    transportOrigin: 'https://127.0.0.1:43117',
    installRoot: macos
      ? '/private/tmp/ccem-updater/CCEM Desktop.app'
      : 'D:\\a\\_temp\\ccem-updater\\app',
    previousProcessIdentitySha256: '5'.repeat(64),
    harnessProcessIdentitySha256: '6'.repeat(64),
    currentProcessIdentitySha256: '7'.repeat(64),
    stages: [...UPDATER_REPLACEMENT_STAGES],
    finalStageReceiptSha256: '8'.repeat(64),
    evidenceSha256: '9'.repeat(64),
    badSignatureRejectedWithoutMutation: true,
    poisonSentinelRemoved: true,
    cefPathCount: 4,
    cefPathSetSha256: 'a'.repeat(64),
    cefInventorySha256: 'b'.repeat(64),
    platformProofKind: macos
      ? 'macos-whole-bundle-replacement'
      : 'windows-nsis-replacement',
    processResidueZero: true,
    attestationSha256: 'c'.repeat(64),
  };
  if (!macos) {
    Object.assign(summary, {
      fixtureAclRestricted: true,
      evidenceAclRestricted: true,
      installedTreePathCount: installedTree?.pathCount,
      installedTreePathSetSha256: installedTree?.pathSetSha256,
      installedTreeInventorySha256: installedTree?.inventorySha256,
    });
  }
  return summary;
}

function createSignedMachOFixture({
  codeByte = 0x42,
  signature = Buffer.alloc(32, 0xa5),
} = {}) {
  const signatureOffset = 128;
  const bytes = Buffer.alloc(signatureOffset + signature.length);
  bytes.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  bytes.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(6, 12); // MH_DYLIB
  bytes.writeUInt32LE(2, 16);
  bytes.writeUInt32LE(88, 20);

  const linkedit = 32;
  bytes.writeUInt32LE(0x19, linkedit); // LC_SEGMENT_64
  bytes.writeUInt32LE(72, linkedit + 4);
  bytes.write('__LINKEDIT', linkedit + 8, 'ascii');
  bytes.writeBigUInt64LE(0x1000n, linkedit + 24);
  bytes.writeBigUInt64LE(BigInt(signature.length + 0x1000), linkedit + 32);
  bytes.writeBigUInt64LE(120n, linkedit + 40);
  bytes.writeBigUInt64LE(BigInt(signature.length + 8), linkedit + 48);
  bytes.writeUInt32LE(1, linkedit + 56);
  bytes.writeUInt32LE(1, linkedit + 60);

  const codeSignature = linkedit + 72;
  bytes.writeUInt32LE(0x1d, codeSignature); // LC_CODE_SIGNATURE
  bytes.writeUInt32LE(16, codeSignature + 4);
  bytes.writeUInt32LE(signatureOffset, codeSignature + 8);
  bytes.writeUInt32LE(signature.length, codeSignature + 12);
  bytes.fill(codeByte, 120, signatureOffset);
  signature.copy(bytes, signatureOffset);
  return bytes;
}

test('macOS release verification plan proves deep signature, stapling, and Gatekeeper for app and DMG', () => {
  const plan = createMacVerificationPlan({
    appDir: '/fixture/CCEM Desktop.app',
    dmgPath: '/fixture/CCEM Desktop.dmg',
  });
  assert.deepEqual(plan[0], {
    program: CODESIGN_PATH,
    args: ['--verify', '--deep', '--strict', '--verbose=4', '/fixture/CCEM Desktop.app'],
  });
  assert.deepEqual(
    plan.filter(({ program, args }) => program === XCRUN_PATH && args[0] === 'stapler'),
    [
      { program: XCRUN_PATH, args: ['stapler', 'validate', '/fixture/CCEM Desktop.app'] },
      { program: XCRUN_PATH, args: ['stapler', 'validate', '/fixture/CCEM Desktop.dmg'] },
    ],
  );
  assert.deepEqual(plan.filter(({ program }) => program === SPCTL_PATH).map(({ args }) => args[2]), [
    'execute',
    'open',
  ]);

  const notaryPlan = createDmgNotarizationPlan({
    dmgPath: '/fixture/CCEM Desktop.dmg',
    keyPath: '/runner-temp/AuthKey_ABCDEFGHIJ.p8',
    keyId: 'ABCDEFGHIJ',
    issuer: '01234567-89ab-cdef-0123-456789abcdef',
  });
  assert.deepEqual(notaryPlan[0].args.slice(0, 3), [
    'notarytool', 'submit', '/fixture/CCEM Desktop.dmg',
  ]);
  assert.deepEqual(notaryPlan[1], {
    program: XCRUN_PATH,
    args: ['stapler', 'staple', '/fixture/CCEM Desktop.dmg'],
  });
  assert.match(JSON.stringify(notaryPlan), /AuthKey_ABCDEFGHIJ\.p8/);
  assert.doesNotMatch(JSON.stringify(notaryPlan), /BEGIN PRIVATE KEY|END PRIVATE KEY/);
  assert.doesNotThrow(() => assertNotaryAccepted(JSON.stringify({
    id: '01234567-89ab-cdef-0123-456789abcdef',
    status: 'Accepted',
  })));
  assert.throws(() => assertNotaryAccepted(JSON.stringify({
    id: '01234567-89ab-cdef-0123-456789abcdef',
    status: 'Invalid',
  })), /was not Accepted/);
});

test('macOS inventory binds the final stapled DMG bytes instead of the pre-notarization hash', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-final-dmg-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dmg = path.join(root, 'CCEM Desktop.dmg');
  const inventory = { artifacts: { dmg: { fileName: path.basename(dmg), sha256: '0'.repeat(64), size: 1 } } };
  const finalBytes = Buffer.from('fixture:post-staple-dmg-bytes');
  await fs.writeFile(dmg, finalBytes);
  const bound = await bindFinalDmgArtifact(inventory, dmg);
  assert.equal(bound.sha256, createHash('sha256').update(finalBytes).digest('hex'));
  assert.equal(bound.size, finalBytes.length);
  assert.deepEqual(inventory.artifacts.dmg, bound);
});

test('macOS canonical Mach-O hash ignores only the mutable code-signature region', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-macho-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'original');
  const signatureOnly = path.join(root, 'signature-only');
  const resigned = path.join(root, 'resigned');
  const tampered = path.join(root, 'tampered');
  await fs.writeFile(original, createSignedMachOFixture());
  await fs.writeFile(signatureOnly, createSignedMachOFixture({
    signature: Buffer.alloc(32, 0x3c),
  }));
  await fs.writeFile(resigned, createSignedMachOFixture({
    signature: Buffer.alloc(57, 0x3c),
  }));
  await fs.writeFile(tampered, createSignedMachOFixture({ codeByte: 0x43 }));

  const originalHash = await canonicalMachOHash(original);
  assert.equal(await canonicalMachOHash(signatureOnly), originalHash);
  assert.equal(await canonicalMachOHash(resigned), originalHash);
  assert.notEqual(await canonicalMachOHash(tampered), originalHash);
});

test('updater signature gate cryptographically verifies the pinned minisign pre-hash format', () => {
  const publicKey = [
    'untrusted comment: minisign public key E7620F1842B4E81F',
    'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
  ].join('\n');
  const signature = [
    'untrusted comment: signature from minisign secret key',
    'RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=',
    'trusted comment: timestamp:1556193335\tfile:test',
    'y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==',
  ].join('\n');
  const verified = verifyTauriUpdaterSignatureBytes({
    artifactDigest: createHash('blake2b512').update('test').digest(),
    encodedSignature: Buffer.from(signature).toString('base64'),
    encodedPublicKey: Buffer.from(publicKey).toString('base64'),
  });
  assert.equal(verified.algorithm, 'minisign-ed25519-blake2b');
  assert.throws(() => verifyTauriUpdaterSignatureBytes({
    artifactDigest: createHash('blake2b512').update('tampered').digest(),
    encodedSignature: Buffer.from(signature).toString('base64'),
    encodedPublicKey: Buffer.from(publicKey).toString('base64'),
  }), /artifact signature is invalid/);
});

test('release inventory set rejects mixed versions, missing targets, and Windows Mode 2 bypass', () => {
  const artifact = (fileName, seed) => ({
    fileName,
    sha256: seed.repeat(64),
    size: 100 + seed.charCodeAt(0),
  });
  const inventory = (platform, overrides = {}) => ({
    schemaVersion: RELEASE_INVENTORY_SCHEMA_VERSION,
    platform,
    appVersion: '2.53.0',
    sourceCommit,
    mode2Included: true,
    cefRuntimeVersion: CEF_FULL_VERSION,
    updaterSignatureVerification: 'minisign-ed25519-blake2b',
    ...(platform.endsWith('apple-darwin')
      ? { cefSafeStorageBranding: { ...safeStorageBranding } }
      : {}),
    ...overrides,
  });
  const windowsStableCefResources = { 'libcef.dll': 'f'.repeat(64) };
  const windowsInstalledTree = createWindowsInstalledTreeInventory({
    directories: ['binaries', 'resources'],
    files: [
      { relativePath: 'binaries/ccem-node.exe', size: 101, sha256: '1'.repeat(64) },
      { relativePath: 'ccem-desktop.exe', size: 102, sha256: 'b'.repeat(64) },
      { relativePath: 'cef-windows-staging-manifest.json', size: 103, sha256: '2'.repeat(64) },
      { relativePath: 'libcef.dll', size: 104, sha256: 'f'.repeat(64) },
      { relativePath: 'resources/native-runtime-helper.mjs', size: 105, sha256: '3'.repeat(64) },
      { relativePath: 'uninstall.exe', size: 106, sha256: '4'.repeat(64) },
    ],
  });
  const windowsRuntimeFingerprint = createWindowsRuntimeInventoryFingerprint({
    installedExecutableSha256: 'b'.repeat(64),
    stableCefResources: windowsStableCefResources,
  });
  const windowsRuntimeAttestation = {
    schemaVersion: WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
    platform: 'x86_64-pc-windows-msvc',
    sourceCommit,
    appVersion: '2.53.0',
    runId: '1234',
    runAttempt: '2',
    repository,
    workflowRef,
    producerWorkflowRef,
    job,
    installedExecutableSha256: 'b'.repeat(64),
    installerSha256: '7'.repeat(64),
    runtimeInventorySha256: windowsRuntimeFingerprint.sha256,
    installedTreeInventorySha256: windowsInstalledTree.inventorySha256,
    installedTreePathSetSha256: windowsInstalledTree.pathSetSha256,
    installedTreePathCount: windowsInstalledTree.pathCount,
    runtimeReceiptSha256: 'd'.repeat(64),
    attestationSha256: 'e'.repeat(64),
    chromiumVersion: WINDOWS_MODE2_CHROMIUM_VERSION,
    sandboxProfile: WINDOWS_MODE2_SANDBOX_PROFILE,
    processTypes: [...WINDOWS_MODE2_REQUIRED_PROCESS_TYPES],
    stages: [...WINDOWS_MODE2_REQUIRED_STAGES],
    lpacSid: 'S-1-15-2-2',
    verifiedPathCount: windowsRuntimeFingerprint.verifiedPathCount,
    verifiedPathsSha256: hashWindowsMode2SmokeJson(windowsRuntimeFingerprint.relativePaths),
    productionPathVerified: true,
    semanticBehaviorVerified: true,
    effectFenceVerified: true,
    profileIsolationVerified: true,
    screenshotArtifactVerified: true,
    nativeWindowVerified: true,
    processTokenSandboxVerified: true,
    networkServiceSandboxed: true,
    upgradeAclNarrowed: true,
    observedDpi: 144,
    profileCleanupVerified: true,
    cleanExit: true,
  };
  const valid = [
    inventory('aarch64-apple-darwin', {
      platformVerification: 'macos-native-release-trust',
      macosSafeStorageRuntimeAttestation: macosSafeStorageRuntimeAttestation(
        'aarch64-apple-darwin',
        '9'.repeat(64),
        'c',
      ),
      dmgNotarization: {
        id: '01234567-89ab-cdef-0123-456789abcdef',
        status: 'Accepted',
      },
      mainExecutable: artifact('ccem-desktop', '9'),
      artifacts: {
        dmg: artifact('CCEM.Desktop_aarch64.dmg', '1'),
        updater: artifact('CCEM.Desktop_aarch64.app.tar.gz', '2'),
        updaterSignature: artifact('CCEM.Desktop_aarch64.app.tar.gz.sig', '3'),
      },
      updaterReplacementAttestation: updaterReplacementAttestation(
        'aarch64-apple-darwin', '9'.repeat(64), '2'.repeat(64), '3'.repeat(64),
      ),
    }),
    inventory('x86_64-apple-darwin', {
      platformVerification: 'macos-native-release-trust',
      macosSafeStorageRuntimeAttestation: macosSafeStorageRuntimeAttestation(
        'x86_64-apple-darwin',
        'a'.repeat(64),
        'd',
      ),
      dmgNotarization: {
        id: '12345678-9abc-def0-1234-56789abcdef0',
        status: 'Accepted',
      },
      mainExecutable: artifact('ccem-desktop', 'a'),
      artifacts: {
        dmg: artifact('CCEM.Desktop_x64.dmg', '4'),
        updater: artifact('CCEM.Desktop_x64.app.tar.gz', '5'),
        updaterSignature: artifact('CCEM.Desktop_x64.app.tar.gz.sig', '6'),
      },
      updaterReplacementAttestation: updaterReplacementAttestation(
        'x86_64-apple-darwin', 'a'.repeat(64), '5'.repeat(64), '6'.repeat(64),
      ),
    }),
    inventory('x86_64-pc-windows-msvc', {
      platformVerification: 'windows-native-authenticode-installed-runtime-smoke',
      cefSourcePin: WINDOWS_CEF_SOURCE_PIN,
      sandboxEnabled: true,
      sameExecutableSubprocesses: true,
      sandboxBootstrapExecutable: WINDOWS_MAIN_EXECUTABLE_NAME,
      sandboxClientLibrary: WINDOWS_SANDBOX_CLIENT_NAME,
      sandboxEntryPoint: WINDOWS_SANDBOX_ENTRY_POINT,
      bootstrapCanonicalSha256: 'd'.repeat(64),
      clientCanonicalSha256: 'e'.repeat(64),
      mainExecutable: artifact('ccem-desktop.exe', 'b'),
      stableCefResources: windowsStableCefResources,
      installedTree: windowsInstalledTree,
      windowsRuntimeAttestation,
      artifacts: {
        updater: artifact('CCEM.Desktop_2.53.0_x64-setup.exe', '7'),
        updaterSignature: artifact('CCEM.Desktop_2.53.0_x64-setup.exe.sig', '8'),
      },
      updaterReplacementAttestation: updaterReplacementAttestation(
        'x86_64-pc-windows-msvc',
        'b'.repeat(64),
        '7'.repeat(64),
        '8'.repeat(64),
        windowsInstalledTree,
      ),
    }),
  ];
  assert.doesNotThrow(() => validateInventorySet(valid, '2.53.0', sourceCommit));
  assert.throws(
    () => validateInventorySet(valid.map((item, index) => (
      index === 0 ? { ...item, macosSafeStorageRuntimeAttestation: undefined } : item
    )), '2.53.0', sourceCommit),
    /release summary must be an object/,
  );
  assert.throws(
    () => validateInventorySet(valid.map((item, index) => (
      index === 2 ? { ...item, windowsRuntimeAttestation: undefined } : item
    )), '2.53.0', sourceCommit),
    /smoke summary must be an object/,
  );
  assert.throws(() => validateInventorySet(valid.slice(0, 2), '2.53.0', sourceCommit), /exactly 3 targets/);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 1 ? { ...item, cefRuntimeVersion: 'mixed' } : item
  )), '2.53.0', sourceCommit), /mixed or unpinned CEF runtime/);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 2 ? { ...item, mode2Included: false, cefRuntimeVersion: null } : item
  )), '2.53.0', sourceCommit), /preview-only/);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 2 ? { ...item, sandboxEnabled: false } : item
  )), '2.53.0', sourceCommit), /signed-runner production smoke/);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 2 ? {
      ...item,
      windowsRuntimeAttestation: {
        ...item.windowsRuntimeAttestation,
        runtimeInventorySha256: '0'.repeat(64),
      },
    } : item
  )), '2.53.0', sourceCommit), /does not bind the published installer and runtime/);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 2 ? { ...item, installedTree: undefined } : item
  )), '2.53.0', sourceCommit), /installed tree|installed-tree/u);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 2 ? {
      ...item,
      updaterReplacementAttestation: {
        ...item.updaterReplacementAttestation,
        installedTreeInventorySha256: '0'.repeat(64),
      },
    } : item
  )), '2.53.0', sourceCommit), /does not bind the exact release target/u);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 2 ? {
      ...item,
      updaterReplacementAttestation: {
        ...item.updaterReplacementAttestation,
        evidenceAclRestricted: false,
      },
    } : item
  )), '2.53.0', sourceCommit), /does not bind the exact release target/u);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 2 ? {
      ...item,
      updaterReplacementAttestation: {
        ...item.updaterReplacementAttestation,
        fixtureAclRestricted: false,
      },
    } : item
  )), '2.53.0', sourceCommit), /does not bind the exact release target/u);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 0 ? { ...item, sourceCommit: 'b'.repeat(40) } : item
  )), '2.53.0', sourceCommit), /source commit/);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 0 ? { ...item, platformVerification: undefined } : item
  )), '2.53.0', sourceCommit), /lacks final native app\/DMG trust verification/);
  assert.throws(() => validateInventorySet(valid.map((item, index) => (
    index === 1 ? {
      ...item,
      artifacts: { ...item.artifacts, residual: artifact('residual.zip', 'c') },
    } : item
  )), '2.53.0', sourceCommit), /exactly the expected release artifact roles/);

  const inventoryFiles = valid.map(({ platform }) => `/fixture/mode2-release-inventory-${platform}.json`);
  assert.doesNotThrow(() => validateInventoryFileBindings(inventoryFiles, valid));
  assert.throws(() => validateInventoryFileBindings([
    inventoryFiles[1],
    inventoryFiles[0],
    inventoryFiles[2],
  ], valid), /does not match target/);
});

test('release mutation preflight allows only a missing or still-draft GitHub release', async () => {
  const request = (releases) => requireDraftGithubRelease({
    repository: 'Genuifx/ccem',
    tag: 'v2.53.0',
    token: 'fixture-token',
    allowMissing: true,
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      if (/\/releases\?per_page=100&page=1$/u.test(url)) {
        return { ok: true, status: 200, json: async () => releases };
      }
      if (/\/releases\/42$/u.test(url)) {
        const listed = releases.find(({ id }) => id === 42);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...listed, assets: [] }),
        };
      }
      assert.fail(`unexpected GitHub API fixture URL: ${url}`);
    },
  });
  assert.deepEqual(await request([]), { state: 'missing', tag: 'v2.53.0' });
  assert.deepEqual(await request([{ id: 42, tag_name: 'v2.53.0', draft: true }]), {
    state: 'draft',
    tag: 'v2.53.0',
    releaseId: 42,
  });
  await assert.rejects(
    request([{ id: 42, tag_name: 'v2.53.0', draft: false }]),
    /already published; refusing to unpublish or mutate it/,
  );
});

test('release workflow gates Mode 2 delivery before updater publication', async () => {
  const [workflow, producerWorkflow] = await Promise.all([
    readRepoText(path.join(repoDir, '.github', 'workflows', 'release-desktop.yml')),
    readRepoText(path.join(repoDir, '.github', 'workflows', 'mode2-signed-producer.yml')),
  ]);
  const combinedWorkflow = `${workflow}\n${producerWorkflow}`;
  const actionRefs = [...combinedWorkflow.matchAll(/^\s*-?\s*uses:\s+([^\s#]+)/gmu)]
    .map((match) => match[1]);
  for (const actionRef of actionRefs) {
    if (actionRef.startsWith('./.github/workflows/')) continue;
    assert.match(actionRef, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u);
  }
  assert.ok((combinedWorkflow.match(/persist-credentials: false/g)?.length ?? 0) >= 5);
  assert.match(workflow, /permissions: \{\}/);
  assert.equal(workflow.match(/contents: write/g)?.length, 1);
  assert.equal(producerWorkflow.match(/contents: write/g)?.length ?? 0, 0);
  assert.ok((combinedWorkflow.match(/node-version: '22'/g)?.length ?? 0) >= 3);
  assert.match(workflow, /concurrency:\n  group: release-desktop\n  cancel-in-progress: false/u);
  assert.match(workflow, /recover_stale_draft:[\s\S]*default: 'false'/u);
  assert.match(producerWorkflow, /pnpm install --frozen-lockfile/);
  assert.match(producerWorkflow, /APPLE_ID: \$\{\{ secrets\.APPLE_ID \}\}/);
  assert.match(producerWorkflow, /APPLE_PASSWORD: \$\{\{ secrets\.APPLE_PASSWORD \}\}/);
  assert.doesNotMatch(combinedWorkflow, /--skip-stapling/);
  assert.match(producerWorkflow, /Import-PfxCertificate/);
  assert.match(producerWorkflow, /CCEM_OFFICIAL_WINDOWS_PUBLISHER/);
  assert.match(producerWorkflow, /stage-cef-windows\.mjs/);
  assert.match(producerWorkflow, /produce-cef-windows-sandbox\.mjs/);
  assert.match(producerWorkflow, /cargo rustc `[\s\S]*?--lib `[\s\S]*?--crate-type cdylib/);
  assert.match(producerWorkflow, /ccem-cef-sandbox\/\$env:GITHUB_RUN_ID-\$env:GITHUB_RUN_ATTEMPT/);
  assert.match(producerWorkflow, /--sandbox-root \$sandboxRoot/);
  assert.match(producerWorkflow, /CCEM_DUMPBIN_PATH/);
  assert.match(producerWorkflow, /tauri\.windows-signing\.conf\.json/);
  assert.match(producerWorkflow, /verify-mode2-release-inventory\.mjs/);
  assert.match(producerWorkflow, /x86_64-apple-darwin --config src-tauri\/tauri\.cef\.conf\.json/);
  assert.doesNotMatch(producerWorkflow, /unsignedArgs:|Preview-only/u);
  assert.doesNotMatch(combinedWorkflow, /includeUpdaterJson|releaseDraft:/);
  assert.doesNotMatch(combinedWorkflow, /require-draft-github-release\.mjs/);
  const tauriActionBlocks = producerWorkflow.match(/uses: tauri-apps\/tauri-action@[\s\S]*?(?=\n\s{6}- name:)/gu) ?? [];
  assert.equal(tauriActionBlocks.length, 2);
  for (const block of tauriActionBlocks) {
    assert.doesNotMatch(block, /GITHUB_TOKEN|tagName|releaseName|releaseBody|releaseDraft|includeUpdaterJson/,
      'tauri-action must build only and have no release mutation access');
  }
  const productionBuildIndex = producerWorkflow.indexOf('- name: Build production bundles without release access');
  const legacyBuildIndex = producerWorkflow.indexOf('- name: Build legacy unsigned bundles with Mode 2 excluded');
  const signedSmokeIndex = producerWorkflow.indexOf('- name: Prove signed macOS Mode 2 Safe Storage and production behavior');
  assert.ok(productionBuildIndex > 0 && productionBuildIndex < legacyBuildIndex);
  assert.ok(legacyBuildIndex < signedSmokeIndex);
  const productionBuildStep = producerWorkflow.slice(productionBuildIndex, legacyBuildIndex);
  const legacyBuildStep = producerWorkflow.slice(legacyBuildIndex, signedSmokeIndex);
  assert.match(productionBuildStep, /needs\.release-mode\.outputs\.production == 'true'/u);
  assert.doesNotMatch(productionBuildStep, /legacyArgs|continue-on-error|failure\(\)/u);
  assert.match(legacyBuildStep, /needs\.release-mode\.outputs\.production != 'true'/u);
  assert.match(legacyBuildStep, /args: \$\{\{ matrix\.legacyArgs \}\}/u);
  assert.doesNotMatch(
    legacyBuildStep,
    /needs\.release-mode\.outputs\.production == 'true'|steps\.[^.]+\.(?:outcome|conclusion)|continue-on-error|failure\(\)|always\(\)/u,
    'a failed production build must not activate the legacy build',
  );
  assert.match(producerWorkflow, /legacyArgs: '--target aarch64-apple-darwin'/u);
  assert.match(producerWorkflow, /legacyArgs: '--target x86_64-apple-darwin'/u);
  assert.match(
    producerWorkflow,
    /legacyArgs: '--target x86_64-pc-windows-msvc --config src-tauri\/tauri\.windows\.conf\.json --bundles nsis,updater'/u,
  );
  for (const legacyArgs of producerWorkflow.match(/^\s+legacyArgs:.*$/gmu) ?? []) {
    assert.doesNotMatch(legacyArgs, /tauri\.cef\.conf\.json|tauri\.windows-signing\.conf\.json/u);
  }
  assert.match(
    producerWorkflow,
    /Prove legacy macOS bundles exclude Mode 2[\s\S]*?verify-legacy-release-inventory\.mjs[\s\S]*?--updater-signature "\$signature_path"/u,
  );
  assert.match(
    producerWorkflow,
    /Prove legacy Windows bundle excludes Mode 2[\s\S]*?verify-legacy-release-inventory\.mjs[\s\S]*?--updater-signature \$signature\[0\]\.FullName/u,
  );
  const legacyVerifierSource = await readRepoText(
    path.join(desktopDir, 'scripts', 'verify-legacy-release-inventory.mjs'),
  );
  assert.match(legacyVerifierSource, /verifyTauriUpdaterSignature/u);
  assert.match(legacyVerifierSource, /updaterSignatureVerification: signature\.algorithm/u);
  assert.match(legacyVerifierSource, /mode2Included: false/u);
  assert.match(legacyVerifierSource, /cefRuntimeVersion: null/u);
  const releaseModeIndex = producerWorkflow.indexOf('  release-mode:');
  const buildJobIndex = producerWorkflow.indexOf('  build-desktop:');
  const evidenceJobIndex = producerWorkflow.indexOf('  verify-evidence:');
  const callJobIndex = workflow.indexOf('  signed-producer:');
  const transactionJobIndex = workflow.indexOf('  publish-updater-manifest:');
  const publishedUpdaterJobIndex = workflow.indexOf('  verify-published-updater:');
  const universalJobIndex = workflow.indexOf('  create-universal:');
  assert.ok(releaseModeIndex > 0 && releaseModeIndex < buildJobIndex && buildJobIndex < evidenceJobIndex);
  assert.ok(callJobIndex > 0 && callJobIndex < transactionJobIndex);
  assert.ok(transactionJobIndex < publishedUpdaterJobIndex && publishedUpdaterJobIndex < universalJobIndex);
  const prepareJob = workflow.slice(0, callJobIndex);
  assert.match(prepareJob, /git fetch --force --no-tags origin "refs\/tags\/\$\{current_tag\}:refs\/tags\/\$\{current_tag\}"/u);
  assert.match(prepareJob, /Release tag \$\{current_tag\} must exist before desktop release builds start/u);
  const releaseModeJob = producerWorkflow.slice(releaseModeIndex, buildJobIndex);
  assert.match(releaseModeJob, /detect-release-mode\.mjs/);
  assert.doesNotMatch(releaseModeJob, /GITHUB_TOKEN|ensure-draft|upload-draft|publish-draft/);
  const releaseModeSource = await readRepoText(
    path.join(desktopDir, 'scripts', 'detect-release-mode.mjs'),
  );
  assert.match(releaseModeSource, /validateMacReleaseSigning\(environment\)/);
  assert.match(releaseModeSource, /validateWindowsReleaseSigning\(environment\)/);
  assert.doesNotMatch(combinedWorkflow, /^  prepare-draft-release:/mu);

  const buildJob = producerWorkflow.slice(buildJobIndex, evidenceJobIndex);
  assert.match(buildJob, /permissions:\n\s+actions: read\n\s+contents: read/u);
  assert.doesNotMatch(buildJob, /contents: write/u);
  assert.ok(buildJob.indexOf('- name: Setup Node.js') < buildJob.indexOf('- name: Require a fresh current-attempt Desktop build'));
  assert.doesNotMatch(buildJob, /detect-actions-release-payload\.mjs|GITHUB_TOKEN/u);
  assert.match(buildJob, /name: mode2-release-payload-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.match(buildJob, /retention-days: 30/u);
  assert.match(buildJob, /inputs\.export_release_payload == true/u);

  const transactionJob = workflow.slice(transactionJobIndex, publishedUpdaterJobIndex);
  assert.match(transactionJob, /needs: \[prepare-release, signed-producer, dsh_bundle_smoke\]/u);
  assert.match(transactionJob, /needs\.signed-producer\.result == 'success'/u);
  assert.match(transactionJob, /needs\.dsh_bundle_smoke\.result == 'success'/u);
  assert.match(transactionJob, /actions: read\n\s+contents: write/u);
  const payloadVerifyIndex = transactionJob.indexOf('- name: Verify exact three immutable payloads and eight assets');
  const draftIndex = transactionJob.indexOf('- name: Create or resume the exact current-run draft release');
  const uploadEightIndex = transactionJob.indexOf('- name: Upload the exact eight verified target assets');
  const createLatestIndex = transactionJob.indexOf('- name: Generate latest.json from verified current-run payload');
  const uploadLatestIndex = transactionJob.indexOf('- name: Upload exact latest.json');
  const exactNineIndex = transactionJob.indexOf('- name: Verify exact nine assets and publish the locked draft');
  assert.ok(payloadVerifyIndex >= 0 && payloadVerifyIndex < draftIndex);
  assert.ok(draftIndex < uploadEightIndex && uploadEightIndex < createLatestIndex);
  assert.ok(createLatestIndex < uploadLatestIndex && uploadLatestIndex < exactNineIndex);
  assert.match(transactionJob, /ensure-draft-github-release\.mjs/u);
  assert.match(transactionJob, /ALLOW_STALE_DRAFT_RECOVERY: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.recover_stale_draft \|\| 'false' \}\}/u);
  assert.match(transactionJob, /upload-draft-release-assets\.mjs --mode payload/u);
  assert.match(transactionJob, /upload-draft-release-assets\.mjs --mode latest/u);
  assert.match(transactionJob, /publish-draft-github-release\.mjs/u);
  assert.equal(transactionJob.match(/EXPECTED_RELEASE_ID: \$\{\{ steps\.draft-release\.outputs\.release_id \}\}/gu)?.length, 3);
  assert.equal(transactionJob.match(/EXPECTED_RELEASE_OWNER_RUN_ID: \$\{\{ steps\.draft-release\.outputs\.release_owner_run_id \}\}/gu)?.length, 3);
  const publishedUpdaterJob = workflow.slice(publishedUpdaterJobIndex, universalJobIndex);
  assert.match(publishedUpdaterJob, /needs: \[prepare-release, publish-updater-manifest\]/u);
  assert.match(publishedUpdaterJob, /permissions: \{\}/u);
  assert.match(publishedUpdaterJob, /inputs\.draft == 'false'/u);
  assert.match(publishedUpdaterJob, /releases\/download\/\$\{encoded_tag\}/u);
  assert.match(publishedUpdaterJob, /--retry-all-errors/u);
  assert.match(publishedUpdaterJob, /--range 0-0/u);
  assert.doesNotMatch(publishedUpdaterJob, /GITHUB_TOKEN|contents: write|secrets\./u);
  assert.doesNotMatch(workflow, /--data '\{"draft":true\}'/);
  const productionReleaseBodyIndex = workflow.indexOf('release_body<<${delimiter}');
  const legacyReleaseBodyIndex = workflow.indexOf('legacy_release_body<<${legacy_delimiter}');
  const releaseBodyEndIndex = workflow.indexOf('- name: Validate release version consistency');
  assert.ok(
    productionReleaseBodyIndex > 0
      && productionReleaseBodyIndex < legacyReleaseBodyIndex
      && legacyReleaseBodyIndex < releaseBodyEndIndex,
  );
  assert.doesNotMatch(
    workflow.slice(productionReleaseBodyIndex, legacyReleaseBodyIndex),
    /xattr -c|clear quarantine/u,
  );
  for (const releaseBody of [
    workflow.slice(productionReleaseBodyIndex, legacyReleaseBodyIndex),
    workflow.slice(legacyReleaseBodyIndex, releaseBodyEndIndex),
  ]) {
    assert.match(releaseBody, /CCEM\.Desktop_\*_aarch64\.dmg/u);
    assert.match(releaseBody, /CCEM\.Desktop_\*_x64\.dmg/u);
    assert.match(releaseBody, /CCEM\.Desktop_\*_x64-setup\.exe/u);
    assert.doesNotMatch(releaseBody, /CCEM-Desktop|CCEM Desktop_/u);
  }
  assert.match(
    workflow.slice(legacyReleaseBodyIndex, releaseBodyEndIndex),
    /legacy unsigned distribution path[\s\S]*CEF Mode 2 is excluded[\s\S]*xattr -c \/Applications\/CCEM\\ Desktop\.app/u,
  );
  assert.doesNotMatch(workflow, /\/releases\/tags\//);
  assert.match(producerWorkflow, /APPLE_NOTARY_API_PRIVATE_KEY/);
  assert.match(producerWorkflow, /notary_key=.*RUNNER_TEMP/);
  assert.doesNotMatch(combinedWorkflow, /Replace draft DMG|--mode replace-dmg/);
  assert.match(producerWorkflow, /--source-commit "?\$GITHUB_SHA"?/);
  assert.match(workflow, /Revalidate protected release source and exact tag/);
  assert.match(workflow, /refs\/tags\/\$\{TAG_NAME\}\^\{commit\}/);
  assert.match(producerWorkflow, /--inventory "src-tauri\/target\/release-gates\/mode2-release-inventory-\$\{CCEM_RELEASE_TARGET\}\.json"/u);
  assert.doesNotMatch(combinedWorkflow, /target\/\*\*\/release-gates/);
  assert.doesNotMatch(combinedWorkflow, /asset_url_regex|asset_url_any/);
  const cargoRustcIndex = producerWorkflow.indexOf('cargo rustc `');
  const producerIndex = producerWorkflow.indexOf('produce-cef-windows-sandbox.mjs');
  const stageIndex = producerWorkflow.indexOf('stage-cef-windows.mjs', producerIndex);
  const bundleIndex = producerWorkflow.indexOf('- name: Build production bundles without release access');
  assert.ok(cargoRustcIndex > 0 && cargoRustcIndex < producerIndex);
  assert.ok(producerIndex < stageIndex && stageIndex < bundleIndex);
  const windowsSmokeIndex = producerWorkflow.indexOf('- name: Run signed installed Windows Mode 2 production smoke');
  const windowsInventoryIndex = producerWorkflow.indexOf('- name: Verify final Windows Authenticode and Mode 2 installer inventory');
  const challengePayloadIndex = producerWorkflow.indexOf('- name: Prepare updater replacement challenge payload');
  const previousSourceIndex = producerWorkflow.indexOf('- name: Derive fresh instrumented previous release source');
  const updaterSmokeIndex = producerWorkflow.indexOf('- name: Prove real previous-to-current updater replacement');
  const updaterSealIndex = producerWorkflow.indexOf('- name: Seal updater replacement receipt into target inventory');
  const payloadPrepareIndex = producerWorkflow.indexOf('- name: Prepare this verified target\'s immutable current-run payload');
  assert.ok(bundleIndex < windowsSmokeIndex && windowsSmokeIndex < windowsInventoryIndex);
  assert.ok(windowsInventoryIndex < challengePayloadIndex);
  assert.ok(challengePayloadIndex < previousSourceIndex && previousSourceIndex < updaterSmokeIndex);
  assert.ok(updaterSmokeIndex < updaterSealIndex && updaterSealIndex < payloadPrepareIndex);
  assert.match(buildJob, /prepare-updater-replacement-previous-source\.mjs/u);
  assert.match(buildJob, /--features updater-replacement-smoke-harness/u);
  assert.match(buildJob, /run-updater-replacement-smoke\.mjs/u);
  assert.match(buildJob, /seal-updater-replacement-release-inventory\.mjs/u);
  assert.match(buildJob, /mode2-release-inventory-base-\$\{CCEM_RELEASE_TARGET\}\.json/u);
  assert.match(buildJob, /updater-replacement-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.match(buildJob, /CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_\*/u);
  const windowsSmokeBlock = producerWorkflow.slice(windowsSmokeIndex, windowsInventoryIndex);
  assert.match(buildJob, /CCEM_WINDOWS_MODE2_ALLOW_PRODUCTION_SMOKE: '1'/u);
  assert.match(buildJob, /run-windows-mode2-production-smoke\.mjs/u);
  assert.match(windowsSmokeBlock, /\$smokeBase = Join-Path \$env:RUNNER_TEMP 'ccem-mode2-production-smoke'/u);
  assert.match(windowsSmokeBlock, /\$smokeRoot = Join-Path \$smokeBase "\$env:GITHUB_RUN_ID-\$env:GITHUB_RUN_ATTEMPT"/u);
  assert.match(windowsSmokeBlock, /\$evidenceRoot = Join-Path \$smokeRoot 'evidence'/u);
  assert.match(windowsSmokeBlock, /\$attestation = Join-Path \$evidenceRoot 'windows-mode2-production-smoke-attestation\.json'/u);
  assert.doesNotMatch(windowsSmokeBlock, /Join-Path[^\n]+['"][^'"\n]*\//u);
  assert.match(buildJob, /--windows-smoke-attestation \$env:CCEM_WINDOWS_MODE2_SMOKE_ATTESTATION/u);
  assert.match(buildJob, /mode2-windows-smoke-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.doesNotMatch(producerWorkflow, /Preview-only|detect-actions-release-payload/u);
});

test('release gate test path cannot execute signing, Keychain, or notarization tools', async () => {
  const inventorySource = await readRepoText(inventoryScript);
  const windowsStageSource = await readRepoText(windowsStageScript);
  const windowsSmokeSource = await readRepoText(
    path.join(desktopDir, 'scripts', 'run-windows-mode2-production-smoke.mjs'),
  );
  assert.match(inventorySource, /CCEM_RELEASE_ALLOW_PLATFORM_VERIFICATION !== '1'/);
  assert.match(windowsStageSource, /CCEM_CEF_ALLOW_SIGNTOOL !== '1'/);
  assert.match(windowsStageSource, /WINDOWS_SOURCE_BOOTSTRAP_NAME/);
  assert.match(windowsStageSource, /WINDOWS_SANDBOX_CLIENT_NAME/);
  assert.match(windowsStageSource, /runner-temp-current-run/);
  assert.match(windowsStageSource, /GITHUB_RUN_ATTEMPT/);
  assert.match(windowsStageSource, /assertRunWinMainExport\(runCommand/);
  assert.match(windowsStageSource, /if \(options\.dryRun\) \{/);
  assert.doesNotMatch(windowsStageSource, /\bsecurity\b|notarytool/);
  assert.doesNotMatch(windowsSmokeSource, /\bsecurity\b|codesign|notarytool/);
  assert.match(windowsSmokeSource, /if \(options\.dryRun\)/u);
  assert.match(windowsSmokeSource, /assertWindowsMode2SmokeAuthorization\(environment, platform\)/u);
  assert.doesNotMatch(inventorySource, /\bsecurity\b/);
  assert.match(inventorySource, /createDmgNotarizationPlan/);
  assert.match(inventorySource, /assertMacCiAuthorization\(\)/);
  assert.doesNotMatch(inventorySource, /signature is empty or truncated/);
  assert.match(inventorySource, /verifyTauriUpdaterSignature/);
  assert.match(inventorySource, /compareMacCefFrameworkTrees\(\{/);
  assert.match(inventorySource, /macReleaseFileFingerprint\(bundledExecutable/);
  assert.match(inventorySource, /assertWindowsMode2ProductionSmokeAttested\(attestation, \{/);
  assert.match(
    inventorySource,
    /direct CDP plus production-manager Ready, shown\/hidden\/reshown, handoff\/pause\/takeover/,
  );
  assert.match(inventorySource, /same-executable CEF children, no --no-sandbox/);
  assert.match(inventorySource, /final runtime directory LPAC ACL \*S-1-15-2-2:\(OI\)\(CI\)\(RX\)/);
});
