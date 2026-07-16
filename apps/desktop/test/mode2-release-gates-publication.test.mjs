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
const sourceCommit = 'a'.repeat(40);
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
    schemaVersion: 1,
    platform,
    status: 'passed',
    sourceCommit,
    appVersion: '2.53.0',
    runId: '1234',
    runAttempt: '2',
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
    repository: 'Genuifx/claude-code-env-manager',
    workflowRef: 'Genuifx/claude-code-env-manager/.github/workflows/release-desktop.yml@refs/tags/v2.53.0',
    job: 'build-desktop',
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
    repository: 'Genuifx/claude-code-env-manager',
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
  const workflow = await fs.readFile(path.join(repoDir, '.github', 'workflows', 'release-desktop.yml'), 'utf8');
  const actionRefs = [...workflow.matchAll(/^\s*-?\s*uses:\s+([^\s#]+)/gmu)]
    .map((match) => match[1]);
  assert.equal(actionRefs.length, 17);
  for (const actionRef of actionRefs) {
    assert.match(actionRef, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u);
  }
  assert.equal(workflow.match(/persist-credentials: false/g)?.length, 4);
  assert.match(workflow, /permissions: \{\}/);
  assert.equal(workflow.match(/contents: write/g)?.length, 1);
  assert.equal(workflow.match(/node-version: '22'/g)?.length, 2);
  assert.match(workflow, /concurrency:\n  group: release-desktop\n  cancel-in-progress: false/u);
  assert.match(workflow, /recover_stale_draft:[\s\S]*default: 'false'/u);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /APPLE_ID: \$\{\{ secrets\.APPLE_ID \}\}/);
  assert.match(workflow, /APPLE_PASSWORD: \$\{\{ secrets\.APPLE_PASSWORD \}\}/);
  assert.doesNotMatch(workflow, /--skip-stapling/);
  assert.match(workflow, /Import-PfxCertificate/);
  assert.match(workflow, /CCEM_OFFICIAL_WINDOWS_PUBLISHER/);
  assert.match(workflow, /stage-cef-windows\.mjs/);
  assert.match(workflow, /produce-cef-windows-sandbox\.mjs/);
  assert.match(workflow, /cargo rustc `[\s\S]*?--lib `[\s\S]*?--crate-type cdylib/);
  assert.match(workflow, /ccem-cef-sandbox\/\$env:GITHUB_RUN_ID-\$env:GITHUB_RUN_ATTEMPT/);
  assert.match(workflow, /--sandbox-root \$sandboxRoot/);
  assert.match(workflow, /CCEM_DUMPBIN_PATH/);
  assert.match(workflow, /tauri\.windows-signing\.conf\.json/);
  assert.match(workflow, /verify-mode2-release-inventory\.mjs/);
  assert.match(workflow, /x86_64-apple-darwin --config src-tauri\/tauri\.cef\.conf\.json/);
  assert.match(workflow, /unsignedArgs: '--target x86_64-apple-darwin'/);
  assert.doesNotMatch(workflow, /includeUpdaterJson|releaseDraft:/);
  assert.doesNotMatch(workflow, /require-draft-github-release\.mjs/);
  const tauriActionBlocks = workflow.match(/uses: tauri-apps\/tauri-action@[\s\S]*?(?=\n\s{6}- name:)/gu) ?? [];
  assert.equal(tauriActionBlocks.length, 2);
  for (const block of tauriActionBlocks) {
    assert.doesNotMatch(block, /GITHUB_TOKEN|tagName|releaseName|releaseBody|releaseDraft|includeUpdaterJson/,
      'tauri-action must build only and have no release mutation access');
  }
  const releaseModeIndex = workflow.indexOf('  release-mode:');
  const buildJobIndex = workflow.indexOf('  build-desktop:');
  const transactionJobIndex = workflow.indexOf('  publish-updater-manifest:');
  const universalJobIndex = workflow.indexOf('  create-universal:');
  assert.ok(releaseModeIndex > 0 && releaseModeIndex < buildJobIndex && buildJobIndex < transactionJobIndex);
  const prepareJob = workflow.slice(0, releaseModeIndex);
  assert.match(prepareJob, /git fetch --force --no-tags origin "refs\/tags\/\$\{current_tag\}:refs\/tags\/\$\{current_tag\}"/u);
  assert.match(prepareJob, /Release tag \$\{current_tag\} must exist before desktop release builds start/u);
  const releaseModeJob = workflow.slice(releaseModeIndex, buildJobIndex);
  assert.match(releaseModeJob, /detect-release-mode\.mjs/);
  assert.doesNotMatch(releaseModeJob, /GITHUB_TOKEN|ensure-draft|upload-draft|publish-draft/);
  const releaseModeSource = await fs.readFile(
    path.join(desktopDir, 'scripts', 'detect-release-mode.mjs'),
    'utf8',
  );
  assert.match(releaseModeSource, /validateMacReleaseSigning\(environment\)/);
  assert.match(releaseModeSource, /validateWindowsReleaseSigning\(environment\)/);
  assert.doesNotMatch(workflow, /^  prepare-draft-release:/mu);

  const buildJob = workflow.slice(buildJobIndex, transactionJobIndex);
  assert.match(buildJob, /permissions:\n\s+actions: read\n\s+contents: read/u);
  assert.doesNotMatch(buildJob, /contents: write/u);
  assert.ok(buildJob.indexOf('- name: Setup Node.js') < buildJob.indexOf('- name: Reuse immutable current-run production payload'));
  assert.match(buildJob, /if: \$\{\{ needs\.release-mode\.outputs\.production == 'true' \}\}[\s\S]*detect-actions-release-payload\.mjs/u);
  assert.match(buildJob, /name: mode2-release-payload-\$\{\{ github\.run_id \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.match(buildJob, /retention-days: 30/u);
  assert.doesNotMatch(buildJob, /mode2-release-payload-[^\n]*run_attempt/u);

  const transactionJob = workflow.slice(transactionJobIndex, universalJobIndex);
  assert.match(transactionJob, /needs: \[prepare-release, release-mode, build-desktop\]/u);
  assert.match(transactionJob, /needs\.release-mode\.outputs\.production == 'true'/u);
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
  assert.doesNotMatch(workflow, /--data '\{"draft":true\}'/);
  assert.doesNotMatch(workflow, /xattr -c|clear quarantine/);
  assert.doesNotMatch(workflow, /\/releases\/tags\//);
  assert.match(workflow, /APPLE_NOTARY_API_PRIVATE_KEY/);
  assert.match(workflow, /notary_key=.*RUNNER_TEMP/);
  assert.doesNotMatch(workflow, /Replace draft DMG|--mode replace-dmg/);
  assert.match(workflow, /--source-commit "?\$GITHUB_SHA"?/);
  assert.match(workflow, /Verify release tag binds the current source commit/);
  assert.match(workflow, /refs\/tags\/\$\{TAG_NAME\}\^\{commit\}/);
  assert.match(workflow, /--inventory "src-tauri\/target\/release-gates\/mode2-release-inventory-\$\{CCEM_RELEASE_TARGET\}\.json"/u);
  assert.doesNotMatch(workflow, /target\/\*\*\/release-gates/);
  assert.doesNotMatch(workflow, /asset_url_regex|asset_url_any/);
  const cargoRustcIndex = workflow.indexOf('cargo rustc `');
  const producerIndex = workflow.indexOf('produce-cef-windows-sandbox.mjs');
  const stageIndex = workflow.indexOf('stage-cef-windows.mjs', producerIndex);
  const bundleIndex = workflow.indexOf('- name: Build production bundles without release access');
  assert.ok(cargoRustcIndex > 0 && cargoRustcIndex < producerIndex);
  assert.ok(producerIndex < stageIndex && stageIndex < bundleIndex);
  const windowsSmokeIndex = workflow.indexOf('- name: Run signed installed Windows Mode 2 production smoke');
  const windowsInventoryIndex = workflow.indexOf('- name: Verify final Windows Authenticode and Mode 2 installer inventory');
  const challengePayloadIndex = workflow.indexOf('- name: Prepare updater replacement challenge payload');
  const previousSourceIndex = workflow.indexOf('- name: Derive fresh instrumented previous release source');
  const updaterSmokeIndex = workflow.indexOf('- name: Prove real previous-to-current updater replacement');
  const updaterSealIndex = workflow.indexOf('- name: Seal updater replacement receipt into target inventory');
  const payloadPrepareIndex = workflow.indexOf('- name: Prepare this verified target\'s immutable current-run payload');
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
  const windowsSmokeBlock = workflow.slice(windowsSmokeIndex, windowsInventoryIndex);
  assert.match(buildJob, /CCEM_WINDOWS_MODE2_ALLOW_PRODUCTION_SMOKE: '1'/u);
  assert.match(buildJob, /run-windows-mode2-production-smoke\.mjs/u);
  assert.match(windowsSmokeBlock, /\$smokeBase = Join-Path \$env:RUNNER_TEMP 'ccem-mode2-production-smoke'/u);
  assert.match(windowsSmokeBlock, /\$smokeRoot = Join-Path \$smokeBase "\$env:GITHUB_RUN_ID-\$env:GITHUB_RUN_ATTEMPT"/u);
  assert.match(windowsSmokeBlock, /\$evidenceRoot = Join-Path \$smokeRoot 'evidence'/u);
  assert.match(windowsSmokeBlock, /\$attestation = Join-Path \$evidenceRoot 'windows-mode2-production-smoke-attestation\.json'/u);
  assert.doesNotMatch(windowsSmokeBlock, /Join-Path[^\n]+['"][^'"\n]*\//u);
  assert.match(buildJob, /--windows-smoke-attestation \$env:CCEM_WINDOWS_MODE2_SMOKE_ATTESTATION/u);
  assert.match(buildJob, /mode2-windows-smoke-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  const previewBuildIndex = workflow.indexOf('- name: Build unsigned Preview-only macOS bundles without release access');
  const previewBuildBlock = workflow.slice(
    previewBuildIndex,
    workflow.indexOf('\n      - name:', previewBuildIndex + 1),
  );
  assert.match(previewBuildBlock, /release-mode\.outputs\.production != 'true'/);
  assert.doesNotMatch(previewBuildBlock, /GITHUB_TOKEN|ensure-draft|upload-draft|publish-draft/);

  const actionsLookupSource = await fs.readFile(
    path.join(desktopDir, 'scripts', 'detect-actions-release-payload.mjs'),
    'utf8',
  );
  assert.match(actionsLookupSource, /\/actions\/runs\/\$\{identity\.runId\}\/artifacts/u);
  assert.doesNotMatch(actionsLookupSource, /\/releases(?:\/|\?)/u);
});

test('release gate test path cannot execute signing, Keychain, or notarization tools', async () => {
  const inventorySource = await fs.readFile(inventoryScript, 'utf8');
  const windowsStageSource = await fs.readFile(windowsStageScript, 'utf8');
  const windowsSmokeSource = await fs.readFile(
    path.join(desktopDir, 'scripts', 'run-windows-mode2-production-smoke.mjs'),
    'utf8',
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
