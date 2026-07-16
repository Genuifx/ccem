import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  UPDATER_REPLACEMENT_CLOCK,
  createUpdaterReplacementCefFingerprint,
  createUpdaterReplacementContextFingerprint,
  hashUpdaterReplacementSmokeJson,
  sealUpdaterReplacementStageReceipt,
  validateUpdaterReplacementSmokeAttestation,
} from '../scripts/updater-replacement-smoke-contract.mjs';
import {
  createWindowsInstalledTreeInventory,
} from '../scripts/windows-mode2-production-smoke-contract.mjs';
import {
  ARTIFACT_SHA256,
  CHALLENGE_NONCE,
  CURRENT_EXECUTABLE_SHA256,
  PREVIOUS_EXECUTABLE_SHA256,
  SOURCE_COMMIT,
  attestationFixture,
  expectedFixture,
  makeProcess,
  refreshEvidence,
} from './updater-replacement-smoke-contract-fixture.test.mjs';

const FIRST_RECEIPT_SHA256 = '0'.repeat(64);
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function rechainStageReceipts(stages) {
  let previousReceiptSha256 = FIRST_RECEIPT_SHA256;
  return stages.map(({ receiptSha256: _discarded, ...stage }) => {
    const receipt = sealUpdaterReplacementStageReceipt({
      ...stage,
      previousReceiptSha256,
    });
    previousReceiptSha256 = receipt.receiptSha256;
    return receipt;
  });
}

function addCleanupHelper(attestation, osStartToken = 'boot-helper-5505') {
  const helper = makeProcess({
    pid: 5_505,
    osStartToken,
    canonicalImagePath: attestation.installation.currentProcess.canonicalImagePath,
    imageSha256: attestation.installation.currentProcess.imageSha256,
    runtimeVersion: attestation.installation.currentProcess.runtimeVersion,
    embeddedSourceCommit: attestation.installation.currentProcess.embeddedSourceCommit,
  });
  attestation.cleanup.observedProcesses.push(helper);
  attestation.cleanup.observedProcesses.sort((left, right) => (
    left.processIdentitySha256 < right.processIdentitySha256 ? -1 : 1
  ));
  return helper;
}

test('canonical hash is key-order independent and rejects non-JSON evidence', () => {
  assert.equal(
    hashUpdaterReplacementSmokeJson({ beta: [2, { zed: true }], alpha: 1 }),
    hashUpdaterReplacementSmokeJson({ alpha: 1, beta: [2, { zed: true }] }),
  );
  assert.throws(() => hashUpdaterReplacementSmokeJson({ value: undefined }), /non-JSON value/);
  const sparse = [];
  sparse[1] = 'evidence';
  assert.throws(() => hashUpdaterReplacementSmokeJson(sparse), /sparse array/);
});

test('production Windows updater explicitly uses non-interactive quiet install mode', () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(desktopDir, 'src-tauri', 'tauri.conf.json'),
    'utf8',
  ));
  assert.equal(config.plugins?.updater?.windows?.installMode, 'quiet');
});

test('Windows fixture and evidence DACLs are protected before installer or app launch', () => {
  const source = fs.readFileSync(
    path.join(desktopDir, 'scripts', 'run-updater-replacement-smoke.mjs'),
    'utf8',
  );
  const fixtureCreated = source.indexOf('await fsp.mkdir(fixtureRoot');
  const fixtureProtected = source.indexOf('await protectWindowsEvidenceRoot(fixtureRoot)');
  const evidenceCreated = source.indexOf('await fsp.mkdir(sharedRoot');
  const evidenceProtected = source.indexOf('await protectWindowsEvidenceRoot(sharedRoot)');
  const previousInstaller = source.indexOf('await installPreviousWindowsFixture({');
  const previousApp = source.indexOf('spawnObserved(executablePath, smokeArguments');
  assert.ok(fixtureCreated >= 0 && fixtureCreated < fixtureProtected);
  assert.ok(fixtureProtected < evidenceCreated && evidenceCreated < evidenceProtected);
  assert.ok(evidenceProtected < previousInstaller && previousInstaller < previousApp);
});

test('schema v3 accepts exact macOS and Windows replacement evidence', () => {
  for (const platform of ['macos', 'windows']) {
    const { expected, attestation } = attestationFixture(platform);
    const summary = validateUpdaterReplacementSmokeAttestation(attestation, expected);
    assert.equal(summary.schemaVersion, 3);
    assert.equal(summary.proofClass, 'instrumented-previous-source');
    assert.equal(summary.repository, expected.run.repository);
    assert.equal(summary.workflowRef, expected.run.workflowRef);
    assert.equal(summary.job, expected.run.job);
    assert.equal(summary.challengeNonce, CHALLENGE_NONCE);
    assert.equal(summary.previousExecutableSha256, PREVIOUS_EXECUTABLE_SHA256);
    assert.equal(summary.currentExecutableSha256, CURRENT_EXECUTABLE_SHA256);
    assert.equal(summary.updaterArtifactSha256, ARTIFACT_SHA256);
    assert.equal(summary.processResidueZero, true);
    if (platform === 'windows') {
      assert.equal(summary.fixtureAclRestricted, true);
      assert.equal(summary.evidenceAclRestricted, true);
      assert.equal(
        summary.installedTreeInventorySha256,
        expected.platformProof.currentInstalledTree.inventorySha256,
      );
      assert.equal(
        summary.installedTreePathSetSha256,
        expected.platformProof.currentInstalledTree.pathSetSha256,
      );
      assert.equal(
        summary.installedTreePathCount,
        expected.platformProof.currentInstalledTree.pathCount,
      );
    }
  }
});

test('proof class and GitHub run identity are mandatory and exact', () => {
  const proofClass = expectedFixture();
  proofClass.proofClass = 'release-binary';
  assert.throws(() => createUpdaterReplacementContextFingerprint(proofClass), /proof class/);

  for (const [field, value, pattern] of [
    ['repository', 'not-a-repository', /owner\/name/],
    ['workflowRef', 'other/repo/.github/workflows/x.yml@refs/heads/main', /repository-bound/],
    ['job', 'invalid job', /job is invalid/],
    ['challengeNonce', 'c'.repeat(63), /exact SHA-256/],
    ['id', '0', /positive GitHub run number/],
    ['attempt', 2, /positive GitHub run number/],
  ]) {
    const expected = expectedFixture();
    expected.run[field] = value;
    assert.throws(() => createUpdaterReplacementContextFingerprint(expected), pattern);
  }
});

test('attestation rejects another run even when source and artifacts match', () => {
  const { expected, attestation } = attestationFixture();
  attestation.run = { ...attestation.run, attempt: '3' };
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
    /current run identity mismatch/,
  );
});

test('old, harness, and current process identities bind every runtime field', () => {
  const forgedDigest = attestationFixture();
  forgedDigest.attestation.installation.currentProcess.imageSha256 = '0'.repeat(64);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(
      forgedDigest.attestation,
      forgedDigest.expected,
    ),
    /process identity digest mismatch/,
  );

  const wrongCommit = attestationFixture();
  const current = wrongCommit.attestation.installation.currentProcess;
  wrongCommit.attestation.installation.currentProcess = makeProcess({
    ...current,
    embeddedSourceCommit: 'f'.repeat(40),
  });
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(wrongCommit.attestation, wrongCommit.expected),
    /runtime identity/,
  );

  const wrongChallenge = attestationFixture();
  const challenged = wrongChallenge.attestation.installation.currentProcess;
  wrongChallenge.attestation.installation.currentProcess = makeProcess({
    ...challenged,
    challengeNonce: '0'.repeat(64),
  });
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(
      wrongChallenge.attestation,
      wrongChallenge.expected,
    ),
    /challenge mismatch/,
  );
});

test('process PIDs and OS start tokens must be independently observed', () => {
  for (const field of ['pid', 'osStartToken']) {
    const { expected, attestation } = attestationFixture();
    const previous = attestation.installation.previousProcess;
    const current = attestation.installation.currentProcess;
    attestation.installation.currentProcess = makeProcess({
      ...current,
      [field]: previous[field],
    });
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
      /process identities must differ/,
    );
  }
});

test('transport expectation requires loopback HTTPS, a pinned CA, and distinct manifests', () => {
  for (const origin of ['http://127.0.0.1:43117', 'https://example.com:43117']) {
    const expected = expectedFixture();
    expected.updater.transport.origin = origin;
    assert.throws(
      () => createUpdaterReplacementContextFingerprint(expected),
      /HTTPS loopback origin/,
    );
  }
  const sameManifest = expectedFixture();
  sameManifest.updater.transport.positive.manifest.responseSha256 =
    sameManifest.updater.transport.negative.manifest.responseSha256;
  assert.throws(
    () => createUpdaterReplacementContextFingerprint(sameManifest),
    /manifests must be byte-distinct/,
  );
  const wrongArtifactBody = expectedFixture();
  wrongArtifactBody.updater.transport.negative.artifact.responseSha256 = '0'.repeat(64);
  assert.throws(
    () => createUpdaterReplacementContextFingerprint(wrongArtifactBody),
    /exact expected artifact bytes/,
  );
});

test('request ledger is nonce-bound, SPKI-pinned, ordered, and redirect-free', () => {
  const mutations = [
    [(transport) => { transport.tlsPeerSpkiSha256 = '1'.repeat(64); }, /pinned loopback HTTPS/],
    [(transport) => { transport.requestLedger[0].nonceHeaderValue = '0'.repeat(64); }, /challenge-bound/],
    [(transport) => { transport.requestLedger[1].sequence = 4; }, /challenge-bound/],
    [(transport) => { transport.requestLedger[2].requestSha256 = '0'.repeat(64); }, /exact pinned/],
    [(transport) => { transport.requestLedger[3].redirectsFollowed = 1; }, /redirect-free/],
    [(transport) => { transport.redirectPolicy = 'follow'; }, /without redirects/],
  ];
  for (const [mutate, pattern] of mutations) {
    const { expected, attestation } = attestationFixture();
    mutate(attestation.updater.transport);
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
      pattern,
    );
  }
});

test('bad signature must be rejected before any positive replacement mutation', () => {
  for (const field of [
    'installTreeAfterRejectionSha256',
    'positiveAttemptStartTreeSha256',
  ]) {
    const { expected, attestation } = attestationFixture();
    attestation.updater.negativeControl[field] = '0'.repeat(64);
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
      /before any replacement mutation/,
    );
  }
  const wrongBadSignature = attestationFixture();
  wrongBadSignature.attestation.updater.negativeControl.badSignatureSha256 = '0'.repeat(64);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(
      wrongBadSignature.attestation,
      wrongBadSignature.expected,
    ),
    /before any replacement mutation/,
  );
});

test('direct install, extraction, installer, signature, and TLS bypasses fail closed', () => {
  for (const field of [
    'directArtifactInstall',
    'directArchiveExtraction',
    'directInstallerInvocation',
    'signatureVerificationDisabled',
    'tlsVerificationDisabled',
  ]) {
    const { expected, attestation } = attestationFixture();
    attestation.updater.instrumentation[field] = true;
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
      /bypass/,
    );
  }
});

test('macOS fixture must be fresh, run-scoped, temporary, and never /Applications', () => {
  const applications = expectedFixture();
  applications.installRoot = '/Applications/CCEM Desktop.app';
  assert.throws(
    () => createUpdaterReplacementContextFingerprint(applications),
    /never use \/Applications/,
  );
  const caseFoldedApplications = expectedFixture();
  caseFoldedApplications.installRoot = '/applications/CCEM Desktop.app';
  assert.throws(
    () => createUpdaterReplacementContextFingerprint(caseFoldedApplications),
    /never use \/Applications/,
  );

  const staleFixture = expectedFixture();
  staleFixture.platformProof.fixtureRoot = '/Users/runner/work/_temp/reused-fixture';
  assert.throws(
    () => createUpdaterReplacementContextFingerprint(staleFixture),
    /inside the install root|strictly inside|current run and challenge/,
  );

  for (const field of ['fixtureInitiallyAbsent', 'fixtureCreatedForCurrentRun']) {
    const { expected, attestation } = attestationFixture();
    attestation.platformProof[field] = false;
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
      /whole-bundle replacement completion proof/,
    );
  }
});

test('macOS proof records completed two-step whole-bundle replacement without atomic-swap claims', () => {
  const atomicClaim = attestationFixture();
  atomicClaim.attestation.platformProof.atomicSwapClaimed = true;
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(
      atomicClaim.attestation,
      atomicClaim.expected,
    ),
    /whole-bundle replacement completion proof/,
  );

  const oldClaim = attestationFixture();
  oldClaim.attestation.platformProof.atomicBundleReplacement = true;
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(oldClaim.attestation, oldClaim.expected),
    /fields differ/,
  );

  const incomplete = attestationFixture();
  incomplete.attestation.platformProof.currentBundleInstalledAtExpectedPath = false;
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(incomplete.attestation, incomplete.expected),
    /whole-bundle replacement completion proof/,
  );
});

test('Windows NSIS proof binds exact path, bytes, start token, and harness-observed exit', () => {
  const pathMismatch = attestationFixture('windows');
  const originalNsis = pathMismatch.attestation.platformProof.nsisProcess;
  pathMismatch.attestation.platformProof.nsisProcess = makeProcess({
    ...originalNsis,
    canonicalImagePath: originalNsis.canonicalImagePath.replace('updater-temp', 'other'),
  });
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(
      pathMismatch.attestation,
      pathMismatch.expected,
    ),
    /NSIS replacement proof/,
  );

  const shaMismatch = attestationFixture('windows');
  const nsis = shaMismatch.attestation.platformProof.nsisProcess;
  shaMismatch.attestation.platformProof.nsisProcess = makeProcess({
    ...nsis,
    imageSha256: '0'.repeat(64),
  });
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(shaMismatch.attestation, shaMismatch.expected),
    /NSIS replacement proof/,
  );

  for (const mutate of [
    (proof) => { proof.nsisProcess.osStartToken = ''; },
    (proof) => { proof.nsisExit.exited = false; },
    (proof) => { proof.nsisExit.code = 1; },
    (proof) => { proof.nsisExit.observedByHarnessProcessIdentitySha256 = '0'.repeat(64); },
    (proof) => { proof.nsisExit.clock = 'process-relative-monotonic-ms'; },
    (proof) => { proof.nsisInvocation.parentPid = 2_202; },
    (proof) => { proof.nsisInvocation.parentOsStartToken = 'boot-harness-2202'; },
    (proof) => { proof.nsisInvocation.harnessWasNotInvoker = false; },
  ]) {
    const { expected, attestation } = attestationFixture('windows');
    mutate(attestation.platformProof);
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
      /OS start token|NSIS exit|NSIS replacement proof/,
    );
  }
  for (const bootMonotonicMs of [700, 1_101]) {
    const { expected, attestation } = attestationFixture('windows');
    attestation.platformProof.nsisExit.bootMonotonicMs = bootMonotonicMs;
    refreshEvidence(attestation);
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
      /after install transition and before current start/,
    );
  }
});

test('Windows expectation binds the NSIS basename to the exact release artifact', () => {
  const expected = expectedFixture('windows');
  expected.platformProof.releaseInstallerPath = expected.platformProof.releaseInstallerPath.replace(
    expected.updater.artifact.fileName,
    'different_2.53.0_x64-setup.exe',
  );
  assert.throws(
    () => createUpdaterReplacementContextFingerprint(expected),
    /exact updater artifact file name/,
  );
  const splitInstallPath = expectedFixture('windows');
  splitInstallPath.platformProof.currentExecutablePath =
    splitInstallPath.platformProof.currentExecutablePath.replace(
      'ccem-desktop.exe',
      'ccem-desktop-current.exe',
    );
  assert.throws(
    () => createUpdaterReplacementContextFingerprint(splitInstallPath),
    /reuse the exact installed executable path/,
  );
});

test('Windows NSIS must be the plugin temp copy, never the release path or a root escape', () => {
  for (const mutate of [
    ({ expected, attestation }) => {
      attestation.platformProof.nsisProcess = makeProcess({
        ...attestation.platformProof.nsisProcess,
        canonicalImagePath: expected.platformProof.releaseInstallerPath,
      });
    },
    ({ attestation }) => {
      attestation.platformProof.nsisProcess = makeProcess({
        ...attestation.platformProof.nsisProcess,
        canonicalImagePath: 'D:\\a\\_temp\\outside\\CCEM Desktop-2.53.0-installer.exe',
      });
    },
  ]) {
    const fixture = attestationFixture('windows');
    mutate(fixture);
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(fixture.attestation, fixture.expected),
      /NSIS replacement proof/,
    );
  }
});

test('Windows same NSIS basename with different bytes or reparse metadata fails closed', () => {
  const bytes = attestationFixture('windows');
  bytes.attestation.platformProof.nsisProcess = makeProcess({
    ...bytes.attestation.platformProof.nsisProcess,
    imageSha256: '0'.repeat(64),
  });
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(bytes.attestation, bytes.expected),
    /NSIS replacement proof/,
  );

  for (const field of [
    'updaterTempRootNoLink', 'updaterTempRootNoReparsePoint',
    'nsisExecutableRegularFile', 'nsisExecutableNoLink', 'nsisExecutableNoReparsePoint',
  ]) {
    const { expected, attestation } = attestationFixture('windows');
    attestation.platformProof[field] = false;
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
      /NSIS replacement proof/,
    );
  }
});

test('poison sentinel must be a regular non-link non-reparse file removed by replacement', () => {
  for (const mutate of [
    (poison) => { poison.rootNoLink = false; },
    (poison) => { poison.rootNoReparsePoint = false; },
    (poison) => { poison.before.regularFile = false; },
    (poison) => { poison.before.noLink = false; },
    (poison) => { poison.before.noReparsePoint = false; },
    (poison) => { poison.after.exists = true; },
  ]) {
    const { expected, attestation } = attestationFixture('windows');
    mutate(attestation.poisonSentinel);
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
      /poison sentinel/,
    );
  }
});

test('Windows paths reject ADS, reserved names, trailing dots, and trailing spaces', () => {
  for (const relativePath of ['marker.bin:stream', 'AUX.txt', 'marker.', 'marker ']) {
    const expected = expectedFixture('windows');
    expected.poisonSentinel.relativePath = relativePath;
    assert.throws(
      () => createUpdaterReplacementContextFingerprint(expected),
      /ADS, reserved name, or trailing dot\/space/,
    );
  }
  for (const relativePath of ['cef.dll:stream', 'CON.dll']) {
    const expected = expectedFixture('windows');
    expected.currentCef.files[relativePath] = '0'.repeat(64);
    assert.throws(
      () => createUpdaterReplacementContextFingerprint(expected),
      /ADS, reserved name, or trailing dot\/space/,
    );
  }
  const reservedSignature = expectedFixture('windows');
  reservedSignature.updater.badSignature.fileName = 'CON.sig';
  assert.throws(
    () => createUpdaterReplacementContextFingerprint(reservedSignature),
    /reserved name/,
  );
});

test('CEF proof requires an exact recursively enumerated regular-file inventory', () => {
  const duplicate = attestationFixture('windows');
  duplicate.attestation.currentCef.files.splice(1, 0, {
    ...duplicate.attestation.currentCef.files[0],
  });
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(duplicate.attestation, duplicate.expected),
    /duplicate or case-colliding/,
  );

  const reparse = attestationFixture('windows');
  reparse.attestation.currentCef.files[0].noReparsePoint = false;
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(reparse.attestation, reparse.expected),
    /regular non-link non-reparse file/,
  );

  for (const field of [
    'missingPaths', 'extraPaths', 'linkPaths', 'reparsePointPaths',
    'adsPaths', 'reservedNamePaths', 'unsupportedEntries',
  ]) {
    const { expected, attestation } = attestationFixture('windows');
    attestation.currentCef[field] = ['zz-unexpected.dll'];
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
      /inventory contains/,
    );
  }

  const incompleteScan = attestationFixture();
  incompleteScan.attestation.currentCef.allEntriesEnumerated = false;
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(
      incompleteScan.attestation,
      incompleteScan.expected,
    ),
    /expected non-link directory/,
  );
});

test('cleanup census binds full start-token identities and proves zero residue', () => {
  const missing = attestationFixture('windows');
  const currentIdentity = missing.attestation.installation.currentProcess.processIdentitySha256;
  missing.attestation.cleanup.observedProcesses =
    missing.attestation.cleanup.observedProcesses.filter(
      (process) => process.processIdentitySha256 !== currentIdentity,
    );
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(missing.attestation, missing.expected),
    /missing an exact start-token/,
  );

  const duplicateStart = attestationFixture('windows');
  addCleanupHelper(
    duplicateStart.attestation,
    duplicateStart.attestation.cleanup.observedProcesses[0].osStartToken,
  );
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(
      duplicateStart.attestation,
      duplicateStart.expected,
    ),
    /duplicate-free/,
  );

  const residue = attestationFixture('windows');
  residue.attestation.cleanup.remainingOwnedProcesses = [
    residue.attestation.installation.currentProcess,
  ];
  residue.attestation.cleanup.residueCount = 1;
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(residue.attestation, residue.expected),
    /residue is not zero/,
  );

  const external = attestationFixture('windows');
  const externalHelper = makeProcess({
    pid: 6_606,
    osStartToken: 'boot-external-6606',
    canonicalImagePath: 'D:\\unowned\\helper.exe',
    imageSha256: '0'.repeat(64),
    runtimeVersion: external.expected.currentVersion,
    embeddedSourceCommit: external.expected.sourceCommit,
  });
  external.attestation.cleanup.observedProcesses.push(externalHelper);
  external.attestation.cleanup.observedProcesses.sort((left, right) => (
    left.processIdentitySha256 < right.processIdentitySha256 ? -1 : 1
  ));
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(external.attestation, external.expected),
    /outside the replacement process tree/,
  );
});

test('stage receipts bind order, actor process identity, monotonic time, and hash chain', () => {
  const wrongOrder = attestationFixture();
  [wrongOrder.attestation.stages[1], wrongOrder.attestation.stages[2]] = [
    wrongOrder.attestation.stages[2],
    wrongOrder.attestation.stages[1],
  ];
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(wrongOrder.attestation, wrongOrder.expected),
    /wrong order/,
  );

  const brokenChain = attestationFixture();
  brokenChain.attestation.stages[3].previousReceiptSha256 = '8'.repeat(64);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(brokenChain.attestation, brokenChain.expected),
    /receipt chain is broken/,
  );

  const forgedActor = attestationFixture();
  forgedActor.attestation.stages[4].processIdentitySha256 =
    forgedActor.attestation.installation.previousProcess.processIdentitySha256;
  forgedActor.attestation.stages = rechainStageReceipts(forgedActor.attestation.stages);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(forgedActor.attestation, forgedActor.expected),
    /wrong order, actor, or process identity/,
  );

  const forgedClock = attestationFixture();
  forgedClock.attestation.stages[3].bootMonotonicMs =
    forgedClock.attestation.stages[2].bootMonotonicMs;
  forgedClock.attestation.stages = rechainStageReceipts(forgedClock.attestation.stages);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(forgedClock.attestation, forgedClock.expected),
    /timestamp is not strictly increasing/,
  );
});

test('first receipt binds negative rejection and final harness receipt seals all evidence', () => {
  const wrongNegativeTime = attestationFixture();
  wrongNegativeTime.attestation.updater.negativeControl.completedBootMonotonicMs = 99;
  refreshEvidence(wrongNegativeTime.attestation);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(
      wrongNegativeTime.attestation,
      wrongNegativeTime.expected,
    ),
    /negative control is not the first sealed stage/,
  );

  const staleEvidence = attestationFixture();
  addCleanupHelper(staleEvidence.attestation);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(staleEvidence.attestation, staleEvidence.expected),
    /complete replacement evidence digest mismatch/,
  );

  const staleStage = attestationFixture();
  addCleanupHelper(staleStage.attestation);
  refreshEvidence(staleStage.attestation, false);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(staleStage.attestation, staleStage.expected),
    /final harness receipt does not seal/,
  );
});

test('platform signing evidence binds each exact executable digest', () => {
  const macos = attestationFixture();
  macos.attestation.platformProof.currentCodeSignature.executableSha256 = '0'.repeat(64);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(macos.attestation, macos.expected),
    /signing identity/,
  );

  const windows = attestationFixture('windows');
  windows.attestation.platformProof.currentExecutableAuthenticode.status = 'NotSigned';
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(windows.attestation, windows.expected),
    /Authenticode identity/,
  );
});

test('Windows replacement proof rejects a validly fingerprinted extra installed residue', () => {
  const windows = attestationFixture('windows');
  const expectedTree = windows.expected.platformProof.currentInstalledTree;
  windows.attestation.platformProof.currentInstalledTree = createWindowsInstalledTreeInventory({
    directories: expectedTree.directories,
    files: [
      ...expectedTree.files,
      { relativePath: 'libcef-old.dll', size: 9, sha256: '9'.repeat(64) },
    ],
  });
  refreshEvidence(windows.attestation);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(windows.attestation, windows.expected),
    /Windows NSIS replacement proof is invalid/u,
  );
});

test('Windows replacement proof rejects non-private or path-mismatched fixture/evidence ACLs', () => {
  for (const mutate of [
    (acl) => { acl.allowedSids.push('S-1-5-32-545'); acl.aceCount = 3; },
    (acl) => { acl.rootPath = 'D:\\a\\_temp\\other-run\\evidence'; },
    (acl) => { acl.inheritanceProtected = false; },
    (acl) => { acl.reparseFree = false; },
  ]) {
    const windows = attestationFixture('windows');
    mutate(windows.attestation.platformProof.evidenceAcl);
    refreshEvidence(windows.attestation);
    assert.throws(
      () => validateUpdaterReplacementSmokeAttestation(
        windows.attestation,
        windows.expected,
      ),
      /evidence root|ACL path|protected/u,
    );
  }
  const fixture = attestationFixture('windows');
  fixture.attestation.platformProof.fixtureAcl.rootPath = 'D:\\a\\_temp\\other-run';
  refreshEvidence(fixture.attestation);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(
      fixture.attestation,
      fixture.expected,
    ),
    /evidence root|ACL path|protected/u,
  );
});

test('schema objects fail closed on unknown fields', () => {
  const { expected, attestation } = attestationFixture();
  attestation.untrusted = true;
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
    /fields differ/,
  );
  const extraProcess = attestationFixture();
  extraProcess.attestation.installation.currentProcess.commandLine = '--forged';
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(
      extraProcess.attestation,
      extraProcess.expected,
    ),
    /fields differ/,
  );
});

test('fixture CEF fingerprint is platform-sensitive and exact', () => {
  const windows = expectedFixture('windows');
  const fingerprint = createUpdaterReplacementCefFingerprint(
    windows.currentCef.files,
    'windows',
  );
  assert.equal(fingerprint.pathCount, Object.keys(windows.currentCef.files).length);
  assert.throws(
    () => createUpdaterReplacementCefFingerprint({ 'CON.dll': '0'.repeat(64) }, 'windows'),
    /reserved name/,
  );
});

test('stage clock contract remains system-boot monotonic', () => {
  const { expected, attestation } = attestationFixture();
  attestation.stages[0].clock = 'process-relative-monotonic-ms';
  attestation.stages = rechainStageReceipts(attestation.stages);
  assert.equal(UPDATER_REPLACEMENT_CLOCK, 'system-boot-monotonic-ms');
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
    /wrong order, actor, or process identity/,
  );
});

test('current source commit cannot masquerade as previous instrumented source', () => {
  const expected = expectedFixture();
  expected.previous.sourceCommit = SOURCE_COMMIT;
  assert.throws(
    () => createUpdaterReplacementContextFingerprint(expected),
    /source commits must differ/,
  );
});

test('previous embedded updater key must verify the current artifact', () => {
  const { expected, attestation } = attestationFixture('macos');
  expected.previous.embeddedUpdaterPublicKeySha256 = '9'.repeat(64);
  attestation.previous.embeddedUpdaterPublicKeySha256 = '9'.repeat(64);
  refreshEvidence(attestation);
  assert.throws(
    () => validateUpdaterReplacementSmokeAttestation(attestation, expected),
    /key rotation requires a separate migration protocol/u,
  );
});
