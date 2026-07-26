import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateMacReleaseSigning,
  validateWindowsReleaseSigning,
  windowsSigningOverlay,
} from '../scripts/validate-release-signing-config.mjs';
import { detectReleaseMode } from '../scripts/detect-release-mode.mjs';
import {
  CODESIGN_PATH,
  RELEASE_INVENTORY_SCHEMA_VERSION,
  SPCTL_PATH,
  XCRUN_PATH,
  assertNotaryAccepted,
  bindFinalDmgArtifact,
  createWindowsAuthenticodeCandidatePaths,
  createDmgNotarizationPlan,
  createMacVerificationPlan,
  inspectWindowsTree,
  WINDOWS_MODE2_RELEASE_BLOCK_REASON,
  validateWindowsAuthenticodeResults,
  validateInventoryFileBindings,
  validateInventorySet,
} from '../scripts/verify-mode2-release-inventory.mjs';
import {
  WINDOWS_MAIN_EXECUTABLE_NAME,
  WINDOWS_RUNTIME_FILES,
  WINDOWS_SANDBOX_CLIENT_NAME,
  WINDOWS_SANDBOX_ENTRY_POINT,
  WINDOWS_SANDBOX_MARKER_NAME,
  WINDOWS_SIGNED_RESOURCE_FILES,
  WINDOWS_SOURCE_BOOTSTRAP_NAME,
  WINDOWS_SOURCE_CLIENT_NAME,
  WINDOWS_STAGE_MANIFEST,
  WINDOWS_CEF_SOURCE_PIN,
  assertRunWinMainExport,
  createWindowsSandboxInspectionPlan,
  createWindowsSandboxMarker,
  createWindowsSigningPlan,
  inspectWindowsRuntime,
} from '../scripts/stage-cef-windows.mjs';
import { CEF_FULL_VERSION } from '../scripts/stage-cef-macos.mjs';
import {
  CEF_LEGAL_DIRECTORY,
  cefArchiveSpec,
  cefFileSetSha256,
  stageCefLegalFiles,
} from '../scripts/cef-runtime-contract.mjs';
import { verifyTauriUpdaterSignatureBytes } from '../scripts/verify-tauri-updater-signature.mjs';
import { canonicalMachOHash } from '../scripts/macos-macho-integrity.mjs';
import { requireDraftGithubRelease } from '../scripts/require-draft-github-release.mjs';
import { produceWindowsSandboxArtifacts } from '../scripts/produce-cef-windows-sandbox.mjs';
import { activateWindowsBootstrap } from '../scripts/activate-cef-windows-host.mjs';
import {
  canonicalPeSha256,
  parsePe,
  patchTauriBundleTypeNsis,
} from '../scripts/windows-pe-contract.mjs';
import {
  WINDOWS_MODE2_REQUIRED_PROCESS_TYPES,
  WINDOWS_MODE2_REQUIRED_STAGES,
  validateWindowsMode2ProductionSmokeAttestation,
} from '../scripts/windows-mode2-production-smoke-contract.mjs';
import { windowsSmokeFixture } from './fixtures/windows-mode2-production-smoke.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(desktopDir, '..', '..');
const windowsStageScript = path.join(desktopDir, 'scripts', 'stage-cef-windows.mjs');
const inventoryScript = path.join(desktopDir, 'scripts', 'verify-mode2-release-inventory.mjs');
const sourceCommit = 'a'.repeat(40);
const PE_FIXTURE = Object.freeze({
  peOffset: 0x80,
  coffOffset: 0x84,
  optionalOffset: 0x98,
  optionalSize: 0xf0,
  headersSize: 0x200,
  rdataRawOffset: 0x200,
  rdataRawSize: 0x200,
  rdataVirtualAddress: 0x2000,
  tauriRawOffset: 0x400,
  tauriRawSize: 0x200,
  tauriVirtualAddress: 0x3000,
  tauriValueOffset: 0x240,
  imageBase: 0x140000000n,
  securityDirectoryOffset: 0x98 + 112 + (4 * 8),
});

function createPeFixture({
  codeByte = 0x42,
  checksum = 0,
  certificate = Buffer.alloc(0),
  tauriValue = 'UNK',
} = {}) {
  const certificateOffset = certificate.length > 0 ? 0x600 : 0;
  const bytes = Buffer.alloc(0x600 + certificate.length);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(PE_FIXTURE.peOffset, 0x3c);
  bytes.write('PE\0\0', PE_FIXTURE.peOffset, 'ascii');
  bytes.writeUInt16LE(0x8664, PE_FIXTURE.coffOffset);
  bytes.writeUInt16LE(2, PE_FIXTURE.coffOffset + 2);
  bytes.writeUInt16LE(PE_FIXTURE.optionalSize, PE_FIXTURE.coffOffset + 16);

  bytes.writeUInt16LE(0x20b, PE_FIXTURE.optionalOffset);
  bytes.writeBigUInt64LE(PE_FIXTURE.imageBase, PE_FIXTURE.optionalOffset + 24);
  bytes.writeUInt32LE(PE_FIXTURE.headersSize, PE_FIXTURE.optionalOffset + 60);
  bytes.writeUInt32LE(checksum, PE_FIXTURE.optionalOffset + 64);
  bytes.writeUInt32LE(16, PE_FIXTURE.optionalOffset + 108);
  bytes.writeUInt32LE(certificateOffset, PE_FIXTURE.securityDirectoryOffset);
  bytes.writeUInt32LE(certificate.length, PE_FIXTURE.securityDirectoryOffset + 4);

  const sectionTable = PE_FIXTURE.optionalOffset + PE_FIXTURE.optionalSize;
  const writeSection = (index, name, virtualAddress, rawOffset, rawSize) => {
    const offset = sectionTable + (index * 40);
    bytes.write(name, offset, 'ascii');
    bytes.writeUInt32LE(rawSize, offset + 8);
    bytes.writeUInt32LE(virtualAddress, offset + 12);
    bytes.writeUInt32LE(rawSize, offset + 16);
    bytes.writeUInt32LE(rawOffset, offset + 20);
  };
  writeSection(
    0,
    '.rdata',
    PE_FIXTURE.rdataVirtualAddress,
    PE_FIXTURE.rdataRawOffset,
    PE_FIXTURE.rdataRawSize,
  );
  writeSection(
    1,
    '.taubndl',
    PE_FIXTURE.tauriVirtualAddress,
    PE_FIXTURE.tauriRawOffset,
    PE_FIXTURE.tauriRawSize,
  );
  bytes.write(tauriValue, PE_FIXTURE.tauriValueOffset, 'ascii');
  bytes[PE_FIXTURE.rdataRawOffset + 0x80] = codeByte;
  bytes.writeBigUInt64LE(
    PE_FIXTURE.imageBase
      + BigInt(PE_FIXTURE.rdataVirtualAddress)
      + BigInt(PE_FIXTURE.tauriValueOffset - PE_FIXTURE.rdataRawOffset),
    PE_FIXTURE.tauriRawOffset,
  );
  bytes.writeBigUInt64LE(3n, PE_FIXTURE.tauriRawOffset + 8);
  if (certificate.length > 0) certificate.copy(bytes, certificateOffset);
  return bytes;
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

const macEnvironment = {
  APPLE_CERTIFICATE: 'fixture-p12',
  APPLE_CERTIFICATE_PASSWORD: 'fixture-certificate-password',
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: CCEM Fixture (ABCDEFGHIJ)',
  APPLE_TEAM_ID: 'ABCDEFGHIJ',
  CCEM_OFFICIAL_APPLE_TEAM_ID: 'ABCDEFGHIJ',
  APPLE_ID: 'release@example.test',
  APPLE_PASSWORD: 'fixture-app-specific-password',
  APPLE_NOTARY_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',
  APPLE_NOTARY_API_KEY_ID: 'ABCDEFGHIJ',
  APPLE_NOTARY_API_ISSUER: '01234567-89ab-cdef-0123-456789abcdef',
};

const windowsEnvironment = {
  WINDOWS_CERTIFICATE: 'fixture-pfx',
  WINDOWS_CERTIFICATE_PASSWORD: 'fixture-password',
  WINDOWS_CERTIFICATE_THUMBPRINT: '00112233445566778899aabbccddeeff00112233',
  WINDOWS_TIMESTAMP_URL: 'https://timestamp.example.test/rfc3161',
  CCEM_OFFICIAL_WINDOWS_PUBLISHER: 'CN=CCEM Fixture, O=CCEM',
};

async function createWindowsRuntime(root, {
  sandboxRoot = root,
  markerOverrides = {},
} = {}) {
  await fs.mkdir(path.join(root, 'locales'), { recursive: true });
  await fs.mkdir(sandboxRoot, { recursive: true });
  await fs.writeFile(path.join(root, 'archive.json'), `${JSON.stringify({
    type: 'minimal',
    name: cefArchiveSpec('x86_64-pc-windows-msvc').name,
    sha1: cefArchiveSpec('x86_64-pc-windows-msvc').sha1,
  })}\n`);
  await fs.writeFile(path.join(root, 'CREDITS.html'), 'fixture Windows CEF credits');
  for (const name of WINDOWS_RUNTIME_FILES) {
    await fs.writeFile(path.join(root, name), `fixture:${name}`);
  }
  const bootstrap = createPeFixture({ tauriValue: 'NSS' });
  const sandboxClient = createPeFixture({ tauriValue: 'NSS', codeByte: 0x43 });
  await fs.writeFile(path.join(root, WINDOWS_SOURCE_BOOTSTRAP_NAME), bootstrap);
  await fs.writeFile(path.join(sandboxRoot, WINDOWS_SOURCE_BOOTSTRAP_NAME), bootstrap);
  await fs.writeFile(path.join(sandboxRoot, WINDOWS_SANDBOX_CLIENT_NAME), sandboxClient);
  await fs.writeFile(path.join(root, 'locales', 'en-US.pak'), 'fixture:en-US');
  await fs.writeFile(path.join(root, 'locales', 'zh-CN.pak'), 'fixture:zh-CN');
  const sourcePin = {
    ...WINDOWS_CEF_SOURCE_PIN,
    runtimeFileSetSha256: await cefFileSetSha256(root, [
      ...WINDOWS_RUNTIME_FILES,
      'locales/en-US.pak',
      'locales/zh-CN.pak',
    ]),
    runtimeLocaleCount: 2,
    bootstrapSha256: createHash('sha256').update(bootstrap).digest('hex'),
    creditsSha256: createHash('sha256').update('fixture Windows CEF credits').digest('hex'),
  };
  const marker = {
    ...createWindowsSandboxMarker({
      gitSha: sourceCommit,
      cefArchiveName: cefArchiveSpec('x86_64-pc-windows-msvc').name,
      cefArchiveSha1: cefArchiveSpec('x86_64-pc-windows-msvc').sha1,
      sourcePin,
      unsignedBootstrapSha256: createHash('sha256').update(bootstrap).digest('hex'),
      unsignedClientLibrarySha256: createHash('sha256').update(sandboxClient).digest('hex'),
      bootstrapCanonicalSha256: canonicalPeSha256(bootstrap),
      clientCanonicalSha256: canonicalPeSha256(sandboxClient),
    }),
    ...markerOverrides,
  };
  await fs.writeFile(path.join(sandboxRoot, WINDOWS_SANDBOX_MARKER_NAME), `${JSON.stringify(marker)}\n`);
  await stageCefLegalFiles({
    runtimeRoot: root,
    outputRoot: root,
    target: 'x86_64-pc-windows-msvc',
  });
  return sourcePin;
}

test('Mode 2 macOS signing requires complete Developer ID and notarization credentials', () => {
  const result = validateMacReleaseSigning(macEnvironment);
  assert.equal(result.identity, macEnvironment.APPLE_SIGNING_IDENTITY);
  assert.equal(result.teamId, 'ABCDEFGHIJ');
  assert.equal(result.notarization.waitForCompletion, true);
  assert.equal(result.notarization.staple, true);

  for (const missing of [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_NOTARY_API_PRIVATE_KEY',
  ]) {
    assert.throws(
      () => validateMacReleaseSigning({ ...macEnvironment, [missing]: '' }),
      new RegExp(`${missing} is required`),
    );
  }
  assert.throws(() => validateMacReleaseSigning({
    ...macEnvironment,
    APPLE_SIGNING_IDENTITY: 'Apple Development: Fixture (ABCDEFGHIJ)',
  }), /exact official Developer ID Application identity/);
});

test('release mode permits Preview only with zero Apple signing values and gates production on both platforms', () => {
  const previewEnvironment = { ...macEnvironment, ...windowsEnvironment };
  for (const name of [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_SIGNING_IDENTITY',
    'APPLE_TEAM_ID',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_NOTARY_API_PRIVATE_KEY',
    'APPLE_NOTARY_API_KEY_ID',
    'APPLE_NOTARY_API_ISSUER',
  ]) previewEnvironment[name] = '';
  assert.deepEqual(detectReleaseMode(previewEnvironment), { mode: 'preview', production: false });
  assert.throws(
    () => detectReleaseMode({ ...previewEnvironment, APPLE_CERTIFICATE: 'partial' }),
    /incomplete; refusing Preview fallback/,
  );
  assert.throws(() => detectReleaseMode(macEnvironment), /WINDOWS_CERTIFICATE is required/);
  assert.deepEqual(
    detectReleaseMode({ ...macEnvironment, ...windowsEnvironment }),
    { mode: 'production', production: true },
  );
});

test('Windows Authenticode overlay pins SHA-256, RFC3161 timestamping, and exact staged CEF resources', () => {
  const signing = validateWindowsReleaseSigning(windowsEnvironment);
  assert.equal(signing.thumbprint, windowsEnvironment.WINDOWS_CERTIFICATE_THUMBPRINT.toUpperCase());
  assert.equal(signing.digestAlgorithm, 'sha256');
  assert.equal(signing.tsp, true);

  const overlay = windowsSigningOverlay(signing);
  assert.deepEqual(overlay.bundle.windows, {
    certificateThumbprint: windowsEnvironment.WINDOWS_CERTIFICATE_THUMBPRINT.toUpperCase(),
    digestAlgorithm: 'sha256',
    timestampUrl: 'https://timestamp.example.test/rfc3161',
    tsp: true,
    nsis: {
      installerHooks: './windows/nsis-mode2-hooks.nsh',
    },
  });
  const expectedResources = [
    WINDOWS_STAGE_MANIFEST,
    WINDOWS_SANDBOX_MARKER_NAME,
    WINDOWS_SANDBOX_CLIENT_NAME,
    ...WINDOWS_RUNTIME_FILES,
  ];
  for (const name of expectedResources) {
    assert.equal(overlay.bundle.resources[`target/cef-bundle/windows/${name}`], name);
  }
  assert.equal(overlay.bundle.resources['target/cef-bundle/windows/locales/'], 'locales');
  assert.equal(
    overlay.bundle.resources['target/cef-bundle/windows/third-party/cef/'],
    'third-party/cef',
  );
  assert.equal(
    overlay.bundle.resources['resources/native-runtime-helper.mjs'],
    'resources/native-runtime-helper.mjs',
  );
  assert.equal(overlay.build.beforeBundleCommand, 'node scripts/prepare-cef-before-bundle.mjs');
  assert.equal(overlay.bundle.resources[`target/cef-bundle/windows/${WINDOWS_SOURCE_BOOTSTRAP_NAME}`], undefined);
  assert.equal(overlay.bundle.resources[`target/cef-bundle/windows/${WINDOWS_MAIN_EXECUTABLE_NAME}`], undefined);
  assert.throws(() => validateWindowsReleaseSigning({
    ...windowsEnvironment,
    WINDOWS_TIMESTAMP_URL: 'http://timestamp.example.test',
  }), /credential-free HTTPS URL/);
  assert.throws(() => validateWindowsReleaseSigning({
    ...windowsEnvironment,
    WINDOWS_CERTIFICATE_THUMBPRINT: 'not-a-thumbprint',
  }), /40-character SHA-1 thumbprint/);
});

test('Windows final Authenticode inspection covers each signed runtime path exactly once', () => {
  const signing = validateWindowsReleaseSigning(windowsEnvironment);
  const runtimeRoot = 'C:\\release\\cef-runtime';
  const mainExecutablePath = 'C:\\release\\ccem-desktop.exe';
  const installerPath = 'C:\\release\\CCEM.Desktop_2.53.0_x64-setup.exe';
  const expectedPaths = createWindowsAuthenticodeCandidatePaths({
    runtimeRoot,
    mainExecutablePath,
    installerPath,
  });
  assert.equal(expectedPaths[0], mainExecutablePath);
  assert.equal(expectedPaths.at(-1), installerPath);
  assert.deepEqual(
    expectedPaths.slice(1, -1).map((candidate) => path.win32.relative(runtimeRoot, candidate)),
    WINDOWS_SIGNED_RESOURCE_FILES,
  );

  const resultFor = (candidate) => ({
    Path: candidate,
    Status: 'Valid',
    SignerThumbprint: signing.thumbprint,
    SignerSubject: signing.publisher,
    TimestampThumbprint: 'B'.repeat(40),
  });
  const results = expectedPaths.map(resultFor).reverse();
  assert.doesNotThrow(() => validateWindowsAuthenticodeResults(
    results,
    signing,
    expectedPaths,
    'fixture artifact',
  ));

  const duplicate = expectedPaths.map(resultFor);
  duplicate[1].Path = duplicate[0].Path;
  assert.throws(
    () => validateWindowsAuthenticodeResults(duplicate, signing, expectedPaths, 'fixture artifact'),
    /duplicate fixture artifact path/,
  );

  const unexpected = expectedPaths.map(resultFor);
  unexpected[1].Path = 'C:\\release\\unexpected.dll';
  assert.throws(
    () => validateWindowsAuthenticodeResults(unexpected, signing, expectedPaths, 'fixture artifact'),
    /unexpected fixture artifact path/,
  );

  assert.throws(
    () => validateWindowsAuthenticodeResults(results.slice(1), signing, expectedPaths, 'fixture artifact'),
    /did not cover every fixture artifact/,
  );

  const invalidTimestamp = expectedPaths.map(resultFor);
  invalidTimestamp[0].TimestampThumbprint = 'present-but-not-a-certificate-thumbprint';
  assert.throws(
    () => validateWindowsAuthenticodeResults(
      invalidTimestamp,
      signing,
      expectedPaths,
      'fixture artifact',
    ),
    /timestamp certificate thumbprint is invalid/,
  );

  const installedPaths = createWindowsAuthenticodeCandidatePaths({
    runtimeRoot: 'C:\\Program Files\\CCEM Desktop',
    mainExecutablePath: 'C:\\Program Files\\CCEM Desktop\\ccem-desktop.exe',
  });
  assert.equal(installedPaths.length, WINDOWS_SIGNED_RESOURCE_FILES.length + 1);
  assert.deepEqual(
    installedPaths.slice(1).map((candidate) => path.win32.basename(candidate)),
    WINDOWS_SIGNED_RESOURCE_FILES,
  );
});

test('Windows NSIS postinstall installs one inheritable LPAC grant without stamping descendants', async () => {
  const hook = await fs.readFile(
    path.join(desktopDir, 'src-tauri', 'windows', 'nsis-mode2-hooks.nsh'),
    'utf8',
  );
  assert.match(hook, /!macro NSIS_HOOK_POSTINSTALL/);
  assert.match(
    hook,
    /\$SYSDIR\\icacls\.exe[\s\S]*\$INSTDIR[\s\S]*\/grant:r \*S-1-15-2-2:\(OI\)\(CI\)\(RX\) \/L \/Q/,
  );
  assert.doesNotMatch(hook, /\/T/);
  assert.doesNotMatch(hook, /\/grant\s+\*S-1-15-2-2/);
  assert.doesNotMatch(hook, /\/C|\(F\)|\(M\)|\(W\)|FullControl|Modify/);
  assert.match(hook, /Pop \$0[\s\S]*\$\{If\} \$0 != 0[\s\S]*Abort/);
});

test('Windows production smoke contract binds runtime stages, process tree, ACL, and clean exit', () => {
  const { attestation, expected } = windowsSmokeFixture();
  const summary = validateWindowsMode2ProductionSmokeAttestation(attestation, expected);
  assert.deepEqual(summary.processTypes, WINDOWS_MODE2_REQUIRED_PROCESS_TYPES);
  assert.deepEqual(summary.stages, WINDOWS_MODE2_REQUIRED_STAGES);
  assert.equal(summary.lpacSid, 'S-1-15-2-2');
  assert.equal(summary.upgradeAclNarrowed, true);
  assert.equal(summary.cleanExit, true);
});

test('Windows production smoke contract rejects unsandboxed or foreign subprocesses', () => {
  const noSandbox = windowsSmokeFixture();
  noSandbox.attestation.runtime.processes[1].commandLine += ' --no-sandbox';
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(noSandbox.attestation, noSandbox.expected),
    /unsandboxed command line/,
  );

  const quotedNoSandbox = windowsSmokeFixture();
  quotedNoSandbox.attestation.runtime.processes[1].commandLine += ' "--no-sandbox"';
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(
      quotedNoSandbox.attestation,
      quotedNoSandbox.expected,
    ),
    /unsandboxed command line/,
  );

  const quotedDisabledSandbox = windowsSmokeFixture();
  quotedDisabledSandbox.attestation.runtime.processes[1].commandLine += ' "--disable-gpu-sandbox"';
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(
      quotedDisabledSandbox.attestation,
      quotedDisabledSandbox.expected,
    ),
    /disabled a Chromium sandbox/,
  );

  const foreignExecutable = windowsSmokeFixture();
  foreignExecutable.attestation.runtime.processes[2].executablePath = 'C:\\Temp\\cef-helper.exe';
  foreignExecutable.attestation.runtime.processes[2].nativeImagePath = 'C:\\Temp\\cef-helper.exe';
  foreignExecutable.attestation.runtime.processClosure[2].nativeImagePath = 'C:\\Temp\\cef-helper.exe';
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(
      foreignExecutable.attestation,
      foreignExecutable.expected,
    ),
    /CEF executable classification is false/,
  );

  const mislabeledProcess = windowsSmokeFixture();
  mislabeledProcess.attestation.runtime.processes[3].commandLine = `"${mislabeledProcess.expected.installedExecutablePath}" --type=renderer`;
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(
      mislabeledProcess.attestation,
      mislabeledProcess.expected,
    ),
    /does not match its command line/,
  );
});

test('Windows production smoke contract rejects missing stages, LPAC write, and process residue', () => {
  const unprovenUpgrade = windowsSmokeFixture();
  unprovenUpgrade.attestation.upgradeAclSeed.writeGranted = false;
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(
      unprovenUpgrade.attestation,
      unprovenUpgrade.expected,
    ),
    /upgrade ACL seed is not bound/,
  );

  const missingStage = windowsSmokeFixture();
  missingStage.attestation.runtime.receipt.stages.pop();
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(missingStage.attestation, missingStage.expected),
    /stages are incomplete/,
  );

  const writableAcl = windowsSmokeFixture();
  writableAcl.attestation.lpacAcl.writeGranted = true;
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(writableAcl.attestation, writableAcl.expected),
    /not exact inherited read-execute/,
  );

  const wrongAclPathSet = windowsSmokeFixture();
  wrongAclPathSet.attestation.lpacAcl.verifiedFiles[1] = 'runtime/foreign-file.bin';
  wrongAclPathSet.attestation.lpacAcl.verifiedFiles.sort();
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(
      wrongAclPathSet.attestation,
      wrongAclPathSet.expected,
    ),
    /did not verify the exact full installed tree/,
  );

  const residue = windowsSmokeFixture();
  residue.attestation.cleanup.remainingOwnedPids = [4101];
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(residue.attestation, residue.expected),
    /remained after the installed smoke/,
  );

  const unboundReceipt = windowsSmokeFixture();
  unboundReceipt.attestation.runtime.receipt.stages.at(-1).monotonicMs = 99;
  assert.throws(
    () => validateWindowsMode2ProductionSmokeAttestation(
      unboundReceipt.attestation,
      unboundReceipt.expected,
    ),
    /receipt digest does not bind/,
  );
});

test('Windows CEF staging rejects unverified fixture bytes before invoking native tools', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-windows-cef-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, 'release');
  const sandboxRoot = path.join(root, 'current-run-sandbox');
  const output = path.join(root, 'must-not-exist');
  const signtoolSentinel = path.join(root, 'signtool-was-executed');
  const dumpbinSentinel = path.join(root, 'dumpbin-was-executed');
  const sourcePin = await createWindowsRuntime(releaseRoot, { sandboxRoot });
  await fs.writeFile(path.join(releaseRoot, WINDOWS_SANDBOX_CLIENT_NAME), 'stale-target-cache-client');
  await fs.writeFile(path.join(releaseRoot, WINDOWS_SANDBOX_MARKER_NAME), '{"stale":true}\n');

  const runtime = await inspectWindowsRuntime(releaseRoot, {
    sandboxRoot,
    expectedGitSha: sourceCommit,
    expectedSourcePin: sourcePin,
  });
  assert.equal(runtime.archive.name, `cef_binary_${CEF_FULL_VERSION}_windows64_minimal.tar.bz2`);
  assert.deepEqual(runtime.files.slice(0, WINDOWS_RUNTIME_FILES.length), WINDOWS_RUNTIME_FILES);
  assert.equal(runtime.sandbox.sandboxEnabled, true);
  assert.equal(runtime.sandbox.noSandboxAllowed, false);
  assert.ok(runtime.files.includes(WINDOWS_SANDBOX_CLIENT_NAME));
  assert.ok(runtime.files.includes(`${CEF_LEGAL_DIRECTORY}/LICENSE.txt`));
  assert.ok(runtime.files.includes(`${CEF_LEGAL_DIRECTORY}/CREDITS.html`));
  assert.ok(!runtime.files.includes(WINDOWS_SOURCE_BOOTSTRAP_NAME));
  assert.deepEqual(runtime.locales, ['en-US.pak', 'zh-CN.pak']);

  const result = spawnSync(process.execPath, [
    windowsStageScript,
    '--dry-run',
    '--target', 'x86_64-pc-windows-msvc',
    '--release-root', releaseRoot,
    '--sandbox-root', sandboxRoot,
    '--output', output,
  ], {
    cwd: desktopDir,
    env: {
      ...process.env,
      ...windowsEnvironment,
      CCEM_SIGNTOOL_PATH: signtoolSentinel,
      CCEM_DUMPBIN_PATH: dumpbinSentinel,
      GITHUB_ACTIONS: 'true',
      RUNNER_OS: 'Windows',
      CCEM_CEF_ALLOW_SIGNTOOL: '1',
      GITHUB_SHA: sourceCommit,
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /verified official Windows archive/);

  const signing = validateWindowsReleaseSigning(windowsEnvironment);
  const plan = createWindowsSigningPlan({ stageDir: output, signing, signtoolPath: signtoolSentinel });
  const inspection = createWindowsSandboxInspectionPlan({ sandboxRoot, dumpbinPath: dumpbinSentinel });
  assert.equal(inspection.program, dumpbinSentinel);
  assert.equal(path.basename(inspection.args.at(-1)), WINDOWS_SANDBOX_CLIENT_NAME);
  assert.equal(plan.sign.length, WINDOWS_SIGNED_RESOURCE_FILES.length);
  assert.equal(plan.sign[0].program, signtoolSentinel);
  assert.deepEqual(plan.sign[0].args.slice(0, 7), [
    'sign', '/fd', 'SHA256', '/td', 'SHA256', '/tr', 'https://timestamp.example.test/rfc3161',
  ]);
  assert.deepEqual(
    plan.targets.map((candidate) => path.basename(candidate)),
    WINDOWS_SIGNED_RESOURCE_FILES,
  );
  assert.equal(await fs.stat(output).then(() => true, () => false), false);
  assert.equal(await fs.stat(signtoolSentinel).then(() => true, () => false), false);
  assert.equal(await fs.stat(dumpbinSentinel).then(() => true, () => false), false);
});

test('Windows CEF source pin rejects runtime, bootstrap, locale, and legal tampering', async (t) => {
  async function fixture(name) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `ccem-windows-source-${name}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sandboxRoot = path.join(root, 'current-run-sandbox');
    const sourcePin = await createWindowsRuntime(root, { sandboxRoot });
    return { root, sandboxRoot, sourcePin };
  }
  const inspect = ({ root, sandboxRoot, sourcePin }) => inspectWindowsRuntime(root, {
    sandboxRoot,
    expectedGitSha: sourceCommit,
    expectedSourcePin: sourcePin,
  });

  const runtime = await fixture('runtime');
  await fs.writeFile(path.join(runtime.root, 'resources.pak'), 'tampered');
  await assert.rejects(() => inspect(runtime), /runtime file set does not match/);

  const bootstrap = await fixture('bootstrap');
  await fs.writeFile(
    path.join(bootstrap.root, WINDOWS_SOURCE_BOOTSTRAP_NAME),
    createPeFixture({ tauriValue: 'NSS', codeByte: 0x44 }),
  );
  await assert.rejects(() => inspect(bootstrap), /bootstrap does not match/);

  const locale = await fixture('locale');
  await fs.writeFile(path.join(locale.root, 'locales', 'unexpected.pak'), 'unexpected');
  await assert.rejects(() => inspect(locale), /locale count must equal/);

  const legal = await fixture('legal');
  await fs.writeFile(path.join(legal.root, 'CREDITS.html'), 'tampered');
  await assert.rejects(() => inspect(legal), /CREDITS\.html does not match/);
});

test('Windows staging and final inventory reject a zh-CN-only locale set', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-windows-locale-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePin = await createWindowsRuntime(root);
  await fs.rm(path.join(root, 'locales', 'en-US.pak'));

  await assert.rejects(
    inspectWindowsRuntime(root, {
      sandboxRoot: root,
      expectedGitSha: sourceCommit,
      expectedSourcePin: sourcePin,
    }),
    /must include en-US\.pak/,
  );
  const expectedCefCreditsSha256 = createHash('sha256')
    .update('fixture Windows CEF credits')
    .digest('hex');
  await assert.rejects(
    inspectWindowsTree({
      root,
      version: '0.0.0-fixture',
      sourceCommit,
      requireApp: false,
      expectedCefCreditsSha256,
      expectedSourcePin: sourcePin,
    }),
    /must include en-US\.pak/,
  );
});

test('Windows release staging fails closed on missing or untruthful sandbox artifacts', async (t) => {
  async function fixture(name, markerOverrides = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `ccem-windows-sandbox-${name}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sandboxRoot = path.join(root, 'current-run-sandbox');
    const sourcePin = await createWindowsRuntime(root, { sandboxRoot, markerOverrides });
    return { root, sandboxRoot, sourcePin };
  }

  const missingMarker = await fixture('missing-marker');
  await fs.rm(path.join(missingMarker.sandboxRoot, WINDOWS_SANDBOX_MARKER_NAME));
  await assert.rejects(() => inspectWindowsRuntime(missingMarker.root, {
    sandboxRoot: missingMarker.sandboxRoot,
    expectedGitSha: sourceCommit,
    expectedSourcePin: missingMarker.sourcePin,
  }), /sandbox artifact marker/);

  const sandboxDisabled = await fixture('disabled', {
    sandboxEnabled: false,
  });
  await assert.rejects(() => inspectWindowsRuntime(sandboxDisabled.root, {
    sandboxRoot: sandboxDisabled.sandboxRoot,
    expectedGitSha: sourceCommit,
    expectedSourcePin: sandboxDisabled.sourcePin,
  }), /sandboxEnabled must equal true/);

  const missingClient = await fixture('missing-client');
  await fs.rm(path.join(missingClient.sandboxRoot, WINDOWS_SANDBOX_CLIENT_NAME));
  await assert.rejects(() => inspectWindowsRuntime(missingClient.root, {
    sandboxRoot: missingClient.sandboxRoot,
    expectedGitSha: sourceCommit,
    expectedSourcePin: missingClient.sourcePin,
  }), /ccem-desktop\.dll/);

  const wrongEntryPoint = await fixture('wrong-entry-point', {
    clientEntryPoint: 'RunConsoleMain',
  });
  await assert.rejects(() => inspectWindowsRuntime(wrongEntryPoint.root, {
    sandboxRoot: wrongEntryPoint.sandboxRoot,
    expectedGitSha: sourceCommit,
    expectedSourcePin: wrongEntryPoint.sourcePin,
  }), /clientEntryPoint must equal "RunWinMain"/);

  const staleCommit = await fixture('stale-commit', { gitSha: 'b'.repeat(40) });
  await assert.rejects(() => inspectWindowsRuntime(staleCommit.root, {
    sandboxRoot: staleCommit.sandboxRoot,
    expectedGitSha: sourceCommit,
    expectedSourcePin: staleCommit.sourcePin,
  }), /gitSha must equal/);
});

test('Windows sandbox export gate accepts only the exact RunWinMain export token', () => {
  assert.doesNotThrow(() => assertRunWinMainExport('  1    0 00001000 RunWinMain\r\n'));
  assert.throws(() => assertRunWinMainExport('  1    0 00001000 _RunWinMain@8\r\n'), /exact RunWinMain/);
  assert.throws(() => assertRunWinMainExport('  1    0 00001000 RunConsoleMain\r\n'), /exact RunWinMain/);
});

test('Windows PE canonical hash ignores Authenticode-only bytes and binds executable code', () => {
  const unsigned = createPeFixture();
  const signed = createPeFixture({
    checksum: 0x12345678,
    certificate: Buffer.alloc(32, 0xa5),
  });
  const resigned = createPeFixture({
    checksum: 0x87654321,
    certificate: Buffer.alloc(64, 0x3c),
  });
  const tampered = createPeFixture({ codeByte: 0x43 });

  assert.equal(canonicalPeSha256(signed), canonicalPeSha256(unsigned));
  assert.equal(canonicalPeSha256(resigned), canonicalPeSha256(unsigned));
  assert.notEqual(canonicalPeSha256(tampered), canonicalPeSha256(unsigned));

  const patched = patchTauriBundleTypeNsis(unsigned);
  assert.equal(patched.previous, 'UNK');
  assert.equal(patched.bytes.subarray(patched.targetOffset, patched.targetOffset + 3).toString(), 'NSS');
  assert.equal(patchTauriBundleTypeNsis(patched.bytes).previous, 'NSS');
});

test('Windows PE parser rejects malformed headers, certificates, and Tauri pointers', () => {
  const shortOptional = createPeFixture();
  shortOptional.writeUInt16LE(151, PE_FIXTURE.coffOffset + 16);
  assert.throws(() => parsePe(shortOptional), /does not contain five data directories/);

  const missingSecurityDirectory = createPeFixture();
  missingSecurityDirectory.writeUInt32LE(4, PE_FIXTURE.optionalOffset + 108);
  assert.throws(() => parsePe(missingSecurityDirectory), /has no security data directory/);

  const oversizedHeaders = createPeFixture();
  oversizedHeaders.writeUInt32LE(0x1000, PE_FIXTURE.optionalOffset + 60);
  assert.throws(() => parsePe(oversizedHeaders), /SizeOfHeaders exceeds/);

  const truncatedHeaders = createPeFixture();
  truncatedHeaders.writeUInt32LE(0x100, PE_FIXTURE.optionalOffset + 60);
  assert.throws(() => parsePe(truncatedHeaders), /does not cover the section table/);

  const misalignedCertificate = createPeFixture({ certificate: Buffer.alloc(32, 0xa5) });
  misalignedCertificate.writeUInt32LE(0x601, PE_FIXTURE.securityDirectoryOffset);
  misalignedCertificate.writeUInt32LE(8, PE_FIXTURE.securityDirectoryOffset + 4);
  assert.throws(() => parsePe(misalignedCertificate), /8-byte aligned/);

  const misalignedCertificateSize = createPeFixture({ certificate: Buffer.alloc(32, 0xa5) });
  misalignedCertificateSize.writeUInt32LE(7, PE_FIXTURE.securityDirectoryOffset + 4);
  assert.throws(() => parsePe(misalignedCertificateSize), /table size must be 8-byte aligned/);

  const headerCertificate = createPeFixture({ certificate: Buffer.alloc(32, 0xa5) });
  headerCertificate.writeUInt32LE(0x100, PE_FIXTURE.securityDirectoryOffset);
  headerCertificate.writeUInt32LE(8, PE_FIXTURE.securityDirectoryOffset + 4);
  assert.throws(() => parsePe(headerCertificate), /overlaps the image headers/);

  const sectionCertificate = createPeFixture({ certificate: Buffer.alloc(32, 0xa5) });
  sectionCertificate.writeUInt32LE(PE_FIXTURE.rdataRawOffset, PE_FIXTURE.securityDirectoryOffset);
  sectionCertificate.writeUInt32LE(8, PE_FIXTURE.securityDirectoryOffset + 4);
  assert.throws(() => parsePe(sectionCertificate), /overlaps section \.rdata/);

  const overlappingSections = createPeFixture();
  const sectionTable = PE_FIXTURE.optionalOffset + PE_FIXTURE.optionalSize;
  overlappingSections.writeUInt32LE(0x300, sectionTable + 40 + 20);
  assert.throws(() => parsePe(overlappingSections), /sections \.rdata and \.taubndl overlap/);

  const crossingPointer = createPeFixture();
  crossingPointer.writeBigUInt64LE(
    PE_FIXTURE.imageBase
      + BigInt(PE_FIXTURE.rdataVirtualAddress + PE_FIXTURE.rdataRawSize - 2),
    PE_FIXTURE.tauriRawOffset,
  );
  assert.throws(() => patchTauriBundleTypeNsis(crossingPointer), /outside the raw \.rdata bytes/);

  const wrongBundleTypeLength = createPeFixture();
  wrongBundleTypeLength.writeBigUInt64LE(4n, PE_FIXTURE.tauriRawOffset + 8);
  assert.throws(() => patchTauriBundleTypeNsis(wrongBundleTypeLength), /length must equal 3/);
});

test('Windows producer emits current-run bootstrap/client provenance and activation swaps only the host', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-windows-producer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, 'release');
  const stageDir = path.join(root, 'current-run');
  const sourcePin = await createWindowsRuntime(releaseRoot);
  const bootstrap = await fs.readFile(path.join(releaseRoot, WINDOWS_SOURCE_BOOTSTRAP_NAME));
  const sourceClient = createPeFixture({ codeByte: 0x43 });
  await fs.writeFile(path.join(releaseRoot, WINDOWS_SOURCE_CLIENT_NAME), sourceClient);

  let inspected = 0;
  const produced = await produceWindowsSandboxArtifacts({
    releaseRoot,
    outputRoot: stageDir,
    gitSha: sourceCommit,
    expectedSourcePin: sourcePin,
    inspectNative: async (candidate) => {
      inspected += 1;
      assert.equal(parsePe(await fs.readFile(path.join(candidate, WINDOWS_SOURCE_BOOTSTRAP_NAME))).machine, 0x8664);
      const client = await fs.readFile(path.join(candidate, WINDOWS_SANDBOX_CLIENT_NAME));
      assert.equal(patchTauriBundleTypeNsis(client).previous, 'NSS');
    },
  });
  assert.equal(inspected, 1);
  assert.equal(produced.marker.bootstrapCanonicalSha256, canonicalPeSha256(bootstrap));
  assert.notEqual(
    produced.marker.clientCanonicalSha256,
    canonicalPeSha256(sourceClient),
    'the producer must bind the NSS-patched client bytes',
  );
  assert.equal(
    await fs.stat(path.join(stageDir, WINDOWS_MAIN_EXECUTABLE_NAME)).then(() => true, () => false),
    false,
  );

  await fs.writeFile(path.join(stageDir, WINDOWS_STAGE_MANIFEST), `${JSON.stringify({
    schemaVersion: 4,
    target: 'x86_64-pc-windows-msvc',
    profile: 'release',
    sourceCommit,
    sourcePin,
    sandbox: produced.marker,
  })}\n`);
  const targetExecutable = path.join(root, WINDOWS_MAIN_EXECUTABLE_NAME);
  const cargoHost = createPeFixture({ codeByte: 0x55, tauriValue: 'NSS' });
  await fs.writeFile(targetExecutable, cargoHost);
  await activateWindowsBootstrap({
    stageDir,
    targetExecutable,
    gitSha: sourceCommit,
    expectedSourcePin: sourcePin,
  });
  const activated = await fs.readFile(targetExecutable);
  assert.equal(canonicalPeSha256(activated), canonicalPeSha256(bootstrap));
  assert.notEqual(canonicalPeSha256(activated), canonicalPeSha256(cargoHost));
});
