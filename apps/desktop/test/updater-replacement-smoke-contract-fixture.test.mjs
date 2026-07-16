import path from 'node:path';

import {
  UPDATER_REPLACEMENT_CLOCK,
  UPDATER_REPLACEMENT_FLOW,
  UPDATER_REPLACEMENT_PROOF_CLASS,
  UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
  UPDATER_REPLACEMENT_STAGE_ACTORS,
  UPDATER_REPLACEMENT_STAGES,
  createUpdaterReplacementCefFingerprint,
  createUpdaterReplacementContextFingerprint,
  createUpdaterReplacementEvidenceFingerprint,
  createUpdaterReplacementProcessIdentityFingerprint,
  hashUpdaterReplacementSmokeJson,
  sealUpdaterReplacementStageReceipt,
} from '../scripts/updater-replacement-smoke-contract.mjs';
import {
  createWindowsInstalledTreeInventory,
} from '../scripts/windows-mode2-production-smoke-contract.mjs';

export const SOURCE_COMMIT = 'a'.repeat(40);
export const PREVIOUS_COMMIT = 'b'.repeat(40);
export const CHALLENGE_NONCE = 'c'.repeat(64);
export const PUBLIC_KEY_SHA256 = 'd'.repeat(64);
export const ARTIFACT_SHA256 = 'e'.repeat(64);
export const SIGNATURE_SHA256 = 'f'.repeat(64);
export const BAD_SIGNATURE_SHA256 = '1'.repeat(64);
export const SENTINEL_SHA256 = '2'.repeat(64);
export const DESIGNATED_REQUIREMENT_SHA256 = '3'.repeat(64);
export const PREVIOUS_EXECUTABLE_SHA256 = '4'.repeat(64);
export const CURRENT_EXECUTABLE_SHA256 = '5'.repeat(64);
export const HARNESS_EXECUTABLE_SHA256 = '6'.repeat(64);
export const INSTRUMENTATION_PATCH_SHA256 = '7'.repeat(64);
export const CA_SPKI_SHA256 = '8'.repeat(64);
export const SERVER_SPKI_SHA256 = '0'.repeat(64);
export const INSTALL_TREE_SHA256 = '9'.repeat(64);
export const SIGNER_THUMBPRINT = 'A'.repeat(40);
export const TIMESTAMP_THUMBPRINT = 'B'.repeat(40);

const FIRST_RECEIPT_SHA256 = '0'.repeat(64);
const TRANSPORT_ORIGIN = 'https://127.0.0.1:43117';
const NONCE_HEADER_NAME = 'X-CCEM-Updater-Challenge';

const macosCefFiles = {
  'Chromium Embedded Framework.framework/Chromium Embedded Framework': 'a'.repeat(64),
  'Chromium Embedded Framework.framework/Resources/icudtl.dat': 'b'.repeat(64),
  'cef-runtime-manifest.json': 'c'.repeat(64),
};

const windowsCefFiles = {
  'ccem-desktop.dll': 'a'.repeat(64),
  'chrome_elf.dll': 'b'.repeat(64),
  'icudtl.dat': 'c'.repeat(64),
  'locales/en-US.pak': 'd'.repeat(64),
};

const windowsInstalledTree = createWindowsInstalledTreeInventory({
  directories: ['binaries', 'cef', 'cef/locales', 'resources'],
  files: [
    { relativePath: 'binaries/ccem-node.exe', size: 101, sha256: '6'.repeat(64) },
    { relativePath: 'ccem-desktop.exe', size: 102, sha256: CURRENT_EXECUTABLE_SHA256 },
    { relativePath: 'cef/ccem-desktop.dll', size: 103, sha256: windowsCefFiles['ccem-desktop.dll'] },
    { relativePath: 'cef/chrome_elf.dll', size: 104, sha256: windowsCefFiles['chrome_elf.dll'] },
    { relativePath: 'cef/icudtl.dat', size: 105, sha256: windowsCefFiles['icudtl.dat'] },
    { relativePath: 'cef/locales/en-US.pak', size: 106, sha256: windowsCefFiles['locales/en-US.pak'] },
    { relativePath: 'resources/native-runtime-helper.mjs', size: 107, sha256: '7'.repeat(64) },
    { relativePath: 'uninstall.exe', size: 108, sha256: '8'.repeat(64) },
  ],
});

function exchange(phase, resource, responseSha256) {
  const sequence = phase === 'negative'
    ? resource === 'manifest' ? 1 : 2
    : resource === 'manifest' ? 3 : 4;
  return {
    url: `${TRANSPORT_ORIGIN}/${phase}/${resource}`,
    requestSha256: String(sequence).repeat(64),
    responseSha256,
    statusCode: 200,
  };
}

function updaterExpectation(platform) {
  const artifactFileName = platform === 'windows'
    ? 'CCEM Desktop_2.53.0_x64-setup.exe'
    : 'CCEM.Desktop_aarch64.app.tar.gz';
  return {
    publicKeySha256: PUBLIC_KEY_SHA256,
    artifact: { fileName: artifactFileName, sha256: ARTIFACT_SHA256 },
    signature: { fileName: `${artifactFileName}.sig`, sha256: SIGNATURE_SHA256 },
    badSignature: {
      fileName: `${artifactFileName}.bad.sig`,
      sha256: BAD_SIGNATURE_SHA256,
    },
    transport: {
      origin: TRANSPORT_ORIGIN,
      caSpkiSha256: CA_SPKI_SHA256,
      serverSpkiSha256: SERVER_SPKI_SHA256,
      nonceHeaderName: NONCE_HEADER_NAME,
      negative: {
        manifest: exchange('negative', 'manifest', 'a'.repeat(64)),
        artifact: exchange('negative', 'artifact', ARTIFACT_SHA256),
      },
      positive: {
        manifest: exchange('positive', 'manifest', 'b'.repeat(64)),
        artifact: exchange('positive', 'artifact', ARTIFACT_SHA256),
      },
    },
  };
}

function commonExpected(platform, paths) {
  return {
    proofClass: UPDATER_REPLACEMENT_PROOF_CLASS,
    platform,
    target: platform === 'windows'
      ? 'x86_64-pc-windows-msvc'
      : 'aarch64-apple-darwin',
    run: {
      id: '12345',
      attempt: '2',
      repository: 'ccem-org/claude-code-env-manager',
      workflowRef: 'ccem-org/claude-code-env-manager/.github/workflows/release-desktop.yml@refs/heads/main',
      job: `updater_replacement_${platform}`,
      challengeNonce: CHALLENGE_NONCE,
    },
    sourceCommit: SOURCE_COMMIT,
    previous: {
      tag: 'v2.52.1',
      sourceCommit: PREVIOUS_COMMIT,
      version: '2.52.1',
      executableSha256: PREVIOUS_EXECUTABLE_SHA256,
      instrumentationPatchSha256: INSTRUMENTATION_PATCH_SHA256,
      embeddedUpdaterPublicKeySha256: PUBLIC_KEY_SHA256,
    },
    harness: {
      canonicalImagePath: paths.harness,
      imageSha256: HARNESS_EXECUTABLE_SHA256,
      runtimeVersion: '2.53.0',
      sourceCommit: SOURCE_COMMIT,
    },
    currentVersion: '2.53.0',
    currentExecutableSha256: CURRENT_EXECUTABLE_SHA256,
    updater: updaterExpectation(platform),
    installRoot: paths.installRoot,
    poisonSentinel: {
      root: paths.poisonRoot,
      absolutePath: paths.poisonPath,
      relativePath: 'old-cef-poison.bin',
      sha256: SENTINEL_SHA256,
    },
    currentCef: {
      root: paths.cefRoot,
      files: { ...(platform === 'windows' ? windowsCefFiles : macosCefFiles) },
    },
  };
}

export function expectedFixture(platform = 'macos') {
  if (platform === 'windows') {
    const fixtureRoot = `D:\\a\\_temp\\ccem-updater-replacement-12345-2-${CHALLENGE_NONCE}`;
    const installRoot = `${fixtureRoot}\\app`;
    const executablePath = `${installRoot}\\ccem-desktop.exe`;
    const artifactFileName = 'CCEM Desktop_2.53.0_x64-setup.exe';
    return {
      ...commonExpected(platform, {
        fixtureRoot,
        installRoot,
        harness: `${fixtureRoot}\\harness\\replacement-harness.exe`,
        poisonRoot: `${installRoot}\\cef`,
        poisonPath: `${installRoot}\\cef\\old-cef-poison.bin`,
        cefRoot: `${installRoot}\\cef`,
      }),
      platformProof: {
        publisher: 'CN=CCEM Release, O=CCEM',
        signerThumbprint: SIGNER_THUMBPRINT,
        releaseInstallerPath: `${fixtureRoot}\\artifacts\\${artifactFileName}`,
        updaterTempRoot: `${fixtureRoot}\\updater-temp`,
        nsisExecutableFileName: 'CCEM Desktop-2.53.0-installer.exe',
        oldExecutablePath: executablePath,
        currentExecutablePath: executablePath,
        currentInstalledTree: windowsInstalledTree,
      },
    };
  }
  const runnerTempRoot = '/Users/runner/work/_temp';
  const fixtureRoot = `${runnerTempRoot}/ccem-updater-replacement-12345-2-${CHALLENGE_NONCE}`;
  const installRoot = `${fixtureRoot}/CCEM Desktop.app`;
  const executablePath = `${installRoot}/Contents/MacOS/ccem-desktop`;
  return {
    ...commonExpected(platform, {
      fixtureRoot,
      installRoot,
      harness: `${runnerTempRoot}/ccem-updater-harness/replacement-harness`,
      poisonRoot: `${installRoot}/Contents/Frameworks`,
      poisonPath: `${installRoot}/Contents/Frameworks/old-cef-poison.bin`,
      cefRoot: `${installRoot}/Contents/Frameworks`,
    }),
    platformProof: {
      bundleIdentifier: 'com.ccem.desktop',
      teamIdentifier: 'ABCDE12345',
      designatedRequirementSha256: DESIGNATED_REQUIREMENT_SHA256,
      runnerTempRoot,
      fixtureRoot,
      oldExecutablePath: executablePath,
      currentExecutablePath: executablePath,
    },
  };
}

export function makeProcess({
  pid,
  osStartToken,
  canonicalImagePath,
  imageSha256,
  runtimeVersion,
  embeddedSourceCommit,
  challengeNonce = CHALLENGE_NONCE,
}) {
  const identity = {
    pid,
    osStartToken,
    canonicalImagePath,
    imageSha256,
    runtimeVersion,
    embeddedSourceCommit,
    challengeNonce,
  };
  return {
    ...identity,
    processIdentitySha256: createUpdaterReplacementProcessIdentityFingerprint(identity),
  };
}

function processSet(expected) {
  const previousProcess = makeProcess({
    pid: 1_101,
    osStartToken: 'boot-previous-1101',
    canonicalImagePath: expected.platformProof.oldExecutablePath,
    imageSha256: expected.previous.executableSha256,
    runtimeVersion: expected.previous.version,
    embeddedSourceCommit: expected.previous.sourceCommit,
  });
  const harnessProcess = makeProcess({
    pid: 2_202,
    osStartToken: 'boot-harness-2202',
    canonicalImagePath: expected.harness.canonicalImagePath,
    imageSha256: expected.harness.imageSha256,
    runtimeVersion: expected.harness.runtimeVersion,
    embeddedSourceCommit: expected.harness.sourceCommit,
  });
  const currentProcess = makeProcess({
    pid: 3_303,
    osStartToken: 'boot-current-3303',
    canonicalImagePath: expected.platformProof.currentExecutablePath,
    imageSha256: expected.currentExecutableSha256,
    runtimeVersion: expected.currentVersion,
    embeddedSourceCommit: expected.sourceCommit,
  });
  const nsisProcess = expected.platform === 'windows' ? makeProcess({
    pid: 4_404,
    osStartToken: 'boot-nsis-4404',
    canonicalImagePath: `${expected.platformProof.updaterTempRoot}\\CCEM Desktop-2.53.0-updater-a1b2c3\\${expected.platformProof.nsisExecutableFileName}`,
    imageSha256: expected.updater.artifact.sha256,
    runtimeVersion: expected.currentVersion,
    embeddedSourceCommit: expected.sourceCommit,
  }) : null;
  return { previousProcess, harnessProcess, currentProcess, nsisProcess };
}

function transportEvidence(expected) {
  const requestLedger = [];
  for (const phase of ['negative', 'positive']) {
    for (const resource of ['manifest', 'artifact']) {
      const exchange = expected.updater.transport[phase][resource];
      requestLedger.push({
        sequence: requestLedger.length + 1,
        phase,
        resource,
        method: 'GET',
        url: exchange.url,
        nonceHeaderName: expected.updater.transport.nonceHeaderName,
        nonceHeaderValue: expected.run.challengeNonce,
        requestSha256: exchange.requestSha256,
        responseSha256: exchange.responseSha256,
        statusCode: exchange.statusCode,
        redirectsFollowed: 0,
      });
    }
  }
  return {
    origin: expected.updater.transport.origin,
    tlsTrustMode: 'pinned-test-ca-spki',
    caSpkiSha256: expected.updater.transport.caSpkiSha256,
    tlsPeerSpkiSha256: expected.updater.transport.serverSpkiSha256,
    nonceHeader: {
      name: expected.updater.transport.nonceHeaderName,
      value: expected.run.challengeNonce,
    },
    redirectPolicy: 'error',
    redirectsFollowed: 0,
    requestLedger,
  };
}

function updaterEvidence(expected, previousProcess) {
  return {
    flow: UPDATER_REPLACEMENT_FLOW,
    publicKeySha256: expected.updater.publicKeySha256,
    artifact: { ...expected.updater.artifact },
    signature: {
      ...expected.updater.signature,
      verified: true,
      verifiedArtifactSha256: expected.updater.artifact.sha256,
    },
    badSignature: { ...expected.updater.badSignature },
    transport: transportEvidence(expected),
    negativeControl: {
      result: 'signature-rejected',
      processIdentitySha256: previousProcess.processIdentitySha256,
      badSignatureFileName: expected.updater.badSignature.fileName,
      badSignatureSha256: expected.updater.badSignature.sha256,
      noMutationBeforePositiveAttempt: true,
      installTreeBeforeSha256: INSTALL_TREE_SHA256,
      installTreeAfterRejectionSha256: INSTALL_TREE_SHA256,
      positiveAttemptStartTreeSha256: INSTALL_TREE_SHA256,
      completedBootMonotonicMs: 100,
    },
    instrumentation: {
      previousSourceHarness: true,
      runtimeEndpointOverride: true,
      pinnedTestCa: true,
      directArtifactInstall: false,
      directArchiveExtraction: false,
      directInstallerInvocation: false,
      signatureVerificationDisabled: false,
      tlsVerificationDisabled: false,
      bypasses: [],
    },
  };
}

function macosPlatformProof(expected) {
  const codeSignature = (executableSha256) => ({
    valid: true,
    teamIdentifier: expected.platformProof.teamIdentifier,
    bundleIdentifier: expected.platformProof.bundleIdentifier,
    designatedRequirementSha256: expected.platformProof.designatedRequirementSha256,
    executableSha256,
  });
  return {
    kind: 'macos-whole-bundle-replacement',
    runnerTempRoot: expected.platformProof.runnerTempRoot,
    fixtureRoot: expected.platformProof.fixtureRoot,
    fixtureInitiallyAbsent: true,
    fixtureCreatedForCurrentRun: true,
    bundlePath: expected.installRoot,
    bundleIdentifier: expected.platformProof.bundleIdentifier,
    oldExecutablePath: expected.platformProof.oldExecutablePath,
    currentExecutablePath: expected.platformProof.currentExecutablePath,
    replacementSemantics: 'tauri-updater-install-returned-current-bundle-observed',
    installApiReturned: true,
    currentBundleInstalledAtExpectedPath: true,
    atomicSwapClaimed: false,
    oldCodeSignature: codeSignature(expected.previous.executableSha256),
    currentCodeSignature: codeSignature(expected.currentExecutableSha256),
  };
}

function authenticode(expected, executableSha256) {
  return {
    status: 'Valid',
    signerThumbprint: expected.platformProof.signerThumbprint,
    publisher: expected.platformProof.publisher,
    timestampThumbprint: TIMESTAMP_THUMBPRINT,
    executableSha256,
  };
}

function windowsPrivateRootAcl(rootPath) {
  const ownerSid = 'S-1-5-21-123456789-234567890-345678901-1001';
  return {
    rootPath,
    ownerSid,
    systemSid: 'S-1-5-18',
    inheritanceProtected: true,
    allowedSids: ['S-1-5-18', ownerSid].sort(),
    aceCount: 2,
    fullControlOnly: true,
    reparseFree: true,
  };
}

function windowsPlatformProof(expected, nsisProcess, harnessProcess, previousProcess) {
  const fixtureRoot = path.win32.dirname(expected.installRoot);
  return {
    kind: 'windows-nsis-replacement',
    oldExecutablePath: expected.platformProof.oldExecutablePath,
    currentExecutablePath: expected.platformProof.currentExecutablePath,
    updaterTempRoot: expected.platformProof.updaterTempRoot,
    updaterTempRootType: 'directory',
    updaterTempRootNoLink: true,
    updaterTempRootNoReparsePoint: true,
    nsisProcess,
    nsisInvocation: {
      method: 'os-process-start-event-with-parent-start-token',
      parentPid: previousProcess.pid,
      parentOsStartToken: previousProcess.osStartToken,
      parentProcessIdentitySha256: previousProcess.processIdentitySha256,
      harnessWasNotInvoker: true,
    },
    nsisExecutableRegularFile: true,
    nsisExecutableNoLink: true,
    nsisExecutableNoReparsePoint: true,
    nsisExit: {
      exited: true,
      code: 0,
      observedByHarnessProcessIdentitySha256: harnessProcess.processIdentitySha256,
      clock: 'system-boot-monotonic-ms',
      bootMonotonicMs: 900,
    },
    silent: true,
    rebootRequired: false,
    installerAuthenticode: authenticode(expected, expected.updater.artifact.sha256),
    oldExecutableAuthenticode: authenticode(expected, expected.previous.executableSha256),
    currentExecutableAuthenticode: authenticode(expected, expected.currentExecutableSha256),
    currentInstalledTree: expected.platformProof.currentInstalledTree,
    fixtureAcl: windowsPrivateRootAcl(fixtureRoot),
    evidenceAcl: windowsPrivateRootAcl(path.win32.join(fixtureRoot, 'evidence')),
  };
}

function poisonObservation(expected) {
  return {
    root: expected.poisonSentinel.root,
    rootType: 'directory',
    rootNoLink: true,
    rootNoReparsePoint: true,
    absolutePath: expected.poisonSentinel.absolutePath,
    relativePath: expected.poisonSentinel.relativePath,
    before: {
      exists: true,
      type: 'file',
      regularFile: true,
      noLink: true,
      noReparsePoint: true,
      sha256: expected.poisonSentinel.sha256,
    },
    after: { exists: false },
  };
}

function cefObservation(expected) {
  const fingerprint = createUpdaterReplacementCefFingerprint(
    expected.currentCef.files,
    expected.platform,
  );
  return {
    root: expected.currentCef.root,
    rootType: 'directory',
    rootNoLink: true,
    rootNoReparsePoint: true,
    files: fingerprint.files,
    pathCount: fingerprint.pathCount,
    pathSetSha256: fingerprint.pathSetSha256,
    inventorySha256: fingerprint.inventorySha256,
    scanMethod: expected.platform === 'windows'
      ? 'immutable-full-install-tree-plus-cef-subset-with-root-reparse-and-ads-enumeration'
      : 'immutable-cef-inventory-recursive-lstat-no-follow',
    allEntriesEnumerated: true,
    missingPaths: [],
    extraPaths: [],
    linkPaths: [],
    reparsePointPaths: [],
    adsPaths: [],
    reservedNamePaths: [],
    unsupportedEntries: [],
  };
}

export function rebuildStages(attestation) {
  const actors = {
    previousApp: attestation.installation.previousProcess,
    harness: attestation.installation.harnessProcess,
    currentApp: attestation.installation.currentProcess,
  };
  let previousReceiptSha256 = FIRST_RECEIPT_SHA256;
  attestation.stages = UPDATER_REPLACEMENT_STAGES.map((name, index) => {
    const receipt = sealUpdaterReplacementStageReceipt({
      name,
      sequence: index + 1,
      actor: UPDATER_REPLACEMENT_STAGE_ACTORS[index],
      processIdentitySha256: actors[UPDATER_REPLACEMENT_STAGE_ACTORS[index]].processIdentitySha256,
      clock: UPDATER_REPLACEMENT_CLOCK,
      bootMonotonicMs: 100 + index * 200,
      wallClockUtc: new Date(Date.UTC(2026, 6, 16, 0, 0, 0, 100 + index * 200)).toISOString(),
      evidenceSha256: index === UPDATER_REPLACEMENT_STAGES.length - 1
        ? attestation.evidenceSha256
        : hashUpdaterReplacementSmokeJson({ name, sequence: index + 1 }),
      contextSha256: attestation.contextSha256,
      previousReceiptSha256,
    });
    previousReceiptSha256 = receipt.receiptSha256;
    return receipt;
  });
}

export function refreshEvidence(attestation, refreshStages = true) {
  attestation.evidenceSha256 = createUpdaterReplacementEvidenceFingerprint(attestation);
  if (refreshStages) rebuildStages(attestation);
}

export function attestationFixture(platform = 'macos') {
  const expected = expectedFixture(platform);
  const processes = processSet(expected);
  const observedProcesses = [processes.previousProcess, processes.currentProcess];
  if (processes.nsisProcess) observedProcesses.push(processes.nsisProcess);
  observedProcesses.sort((left, right) => (
    left.processIdentitySha256 < right.processIdentitySha256 ? -1 : 1
  ));
  const attestation = {
    schemaVersion: UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
    proofClass: UPDATER_REPLACEMENT_PROOF_CLASS,
    platform: expected.platform,
    target: expected.target,
    contextSha256: createUpdaterReplacementContextFingerprint(expected),
    evidenceSha256: '0'.repeat(64),
    run: { ...expected.run },
    sourceCommit: expected.sourceCommit,
    previous: { ...expected.previous },
    currentVersion: expected.currentVersion,
    currentExecutableSha256: expected.currentExecutableSha256,
    updater: updaterEvidence(expected, processes.previousProcess),
    installation: {
      root: expected.installRoot,
      previousProcess: processes.previousProcess,
      harnessProcess: processes.harnessProcess,
      currentProcess: processes.currentProcess,
    },
    stages: [],
    poisonSentinel: poisonObservation(expected),
    currentCef: cefObservation(expected),
    platformProof: platform === 'macos'
      ? macosPlatformProof(expected)
      : windowsPlatformProof(
        expected,
        processes.nsisProcess,
        processes.harnessProcess,
        processes.previousProcess,
      ),
    cleanup: {
      scope: 'replaced-installation-process-tree-and-descendants',
      method: 'os-process-census-by-pid-start-token-image-and-challenge',
      challengeNonce: expected.run.challengeNonce,
      observedProcesses,
      remainingOwnedProcesses: [],
      residueCount: 0,
    },
  };
  refreshEvidence(attestation);
  return { expected, attestation };
}
