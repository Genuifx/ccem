import path from 'node:path';

import {
  assertPathInside,
  exactAbsolutePath,
  exactKeys,
  exactNonEmptyText,
  exactSha256,
  fail,
  nonNegativeInteger,
  pathIsInside,
  samePath,
  validateProcessIdentity,
} from './updater-replacement-smoke-contract-core.mjs';
import {
  validateWindowsInstalledTreeInventory,
} from './windows-mode2-production-smoke-contract.mjs';
import {
  validateWindowsEvidenceRootAclObservation,
} from './windows-mode2-production-smoke-inspection.mjs';

function assertStrictlyInside(candidate, root, platform, label) {
  assertPathInside(candidate, root, platform, label);
  if (samePath(candidate, root, platform)) fail(`${label} must be strictly inside its root`);
}

export function validateMacosProofExpectation(value, installRoot, run) {
  exactKeys(value, [
    'bundleIdentifier', 'teamIdentifier', 'designatedRequirementSha256',
    'runnerTempRoot', 'fixtureRoot', 'oldExecutablePath', 'currentExecutablePath',
  ], 'macOS proof expectation');
  if (typeof value.bundleIdentifier !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/u.test(value.bundleIdentifier)) {
    fail('macOS bundle identifier is invalid');
  }
  if (!/^[A-Z0-9]{10}$/u.test(value.teamIdentifier ?? '')) fail('macOS team identifier is invalid');
  const runnerTempRoot = exactAbsolutePath(
    value.runnerTempRoot,
    'macos',
    'macOS runner temp root',
  );
  const fixtureRoot = exactAbsolutePath(value.fixtureRoot, 'macos', 'macOS fixture root');
  assertStrictlyInside(fixtureRoot, runnerTempRoot, 'macos', 'macOS fixture root');
  assertStrictlyInside(installRoot, fixtureRoot, 'macos', 'macOS install bundle');
  if (pathIsInside(installRoot, '/Applications', 'macos')) {
    fail('macOS updater fixture must never use /Applications');
  }
  const expectedFixtureSuffix = [
    'ccem-updater-replacement', run.id, run.attempt, run.challengeNonce,
  ].join('-');
  if (!fixtureRoot.endsWith(`/${expectedFixtureSuffix}`)) {
    fail('macOS fixture root must bind the current run and challenge');
  }
  const oldExecutablePath = exactAbsolutePath(value.oldExecutablePath, 'macos', 'old macOS executable');
  const currentExecutablePath = exactAbsolutePath(value.currentExecutablePath, 'macos', 'current macOS executable');
  assertPathInside(oldExecutablePath, installRoot, 'macos', 'old macOS executable');
  assertPathInside(currentExecutablePath, installRoot, 'macos', 'current macOS executable');
  if (!samePath(oldExecutablePath, currentExecutablePath, 'macos')) {
    fail('macOS replacement must reuse the exact installed executable path');
  }
  return {
    bundleIdentifier: value.bundleIdentifier,
    teamIdentifier: value.teamIdentifier,
    designatedRequirementSha256: exactSha256(value.designatedRequirementSha256, 'macOS designated requirement'),
    runnerTempRoot,
    fixtureRoot,
    oldExecutablePath,
    currentExecutablePath,
  };
}

export function validateWindowsProofExpectation(value, installRoot) {
  exactKeys(value, [
    'publisher', 'signerThumbprint', 'releaseInstallerPath', 'updaterTempRoot',
    'nsisExecutableFileName', 'oldExecutablePath', 'currentExecutablePath',
    'currentInstalledTree',
  ], 'Windows proof expectation');
  const publisher = exactNonEmptyText(value.publisher, 'Windows publisher');
  if (!/^[A-F0-9]{40}$/u.test(value.signerThumbprint ?? '')) {
    fail('Windows signer thumbprint is invalid');
  }
  const releaseInstallerPath = exactAbsolutePath(
    value.releaseInstallerPath,
    'windows',
    'Windows release installer',
  );
  if (!releaseInstallerPath.endsWith('setup.exe')) {
    fail('Windows release installer path must end in setup.exe');
  }
  if (pathIsInside(releaseInstallerPath, installRoot, 'windows')) {
    fail('Windows release installer must be outside the replacement install root');
  }
  const updaterTempRoot = exactAbsolutePath(
    value.updaterTempRoot,
    'windows',
    'Windows updater temp root',
  );
  if (pathIsInside(updaterTempRoot, installRoot, 'windows')) {
    fail('Windows updater temp root must be outside the replacement install root');
  }
  if (pathIsInside(releaseInstallerPath, updaterTempRoot, 'windows')) {
    fail('Windows release installer must be outside the updater temp root');
  }
  const nsisExecutableFileName = exactNonEmptyText(
    value.nsisExecutableFileName,
    'Windows updater NSIS file name',
    255,
  );
  if (
    path.win32.basename(nsisExecutableFileName) !== nsisExecutableFileName
    || !nsisExecutableFileName.endsWith('-installer.exe')
    || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(nsisExecutableFileName)
  ) {
    fail('Windows updater NSIS file name must match the plugin temporary installer basename');
  }
  const oldExecutablePath = exactAbsolutePath(value.oldExecutablePath, 'windows', 'old Windows executable');
  const currentExecutablePath = exactAbsolutePath(value.currentExecutablePath, 'windows', 'current Windows executable');
  assertPathInside(oldExecutablePath, installRoot, 'windows', 'old Windows executable');
  assertPathInside(currentExecutablePath, installRoot, 'windows', 'current Windows executable');
  if (!samePath(oldExecutablePath, currentExecutablePath, 'windows')) {
    fail('Windows replacement must reuse the exact installed executable path');
  }
  const currentInstalledTree = validateWindowsInstalledTreeInventory(
    value.currentInstalledTree,
    'expected current Windows installed tree',
  );
  return {
    publisher,
    signerThumbprint: value.signerThumbprint,
    releaseInstallerPath,
    updaterTempRoot,
    nsisExecutableFileName,
    oldExecutablePath,
    currentExecutablePath,
    currentInstalledTree,
  };
}

function validateMacosCodeSignature(signature, expected, executableSha256, label) {
  exactKeys(signature, [
    'valid', 'teamIdentifier', 'bundleIdentifier', 'designatedRequirementSha256',
    'executableSha256',
  ], label);
  if (
    signature.valid !== true
    || signature.teamIdentifier !== expected.teamIdentifier
    || signature.bundleIdentifier !== expected.bundleIdentifier
    || signature.designatedRequirementSha256 !== expected.designatedRequirementSha256
    || exactSha256(signature.executableSha256, `${label} executable digest`) !== executableSha256
  ) {
    fail(`${label} does not match the expected signing identity`);
  }
}

export function validateMacosPlatformProof(proof, expected, installRoot, previousSha, currentSha) {
  exactKeys(proof, [
    'kind', 'runnerTempRoot', 'fixtureRoot', 'fixtureInitiallyAbsent',
    'fixtureCreatedForCurrentRun', 'bundlePath', 'bundleIdentifier',
    'oldExecutablePath', 'currentExecutablePath', 'replacementSemantics',
    'installApiReturned', 'currentBundleInstalledAtExpectedPath',
    'atomicSwapClaimed', 'oldCodeSignature',
    'currentCodeSignature',
  ], 'macOS replacement proof');
  if (
    proof.kind !== 'macos-whole-bundle-replacement'
    || !samePath(
      exactAbsolutePath(proof.runnerTempRoot, 'macos', 'attested macOS runner temp root'),
      expected.runnerTempRoot,
      'macos',
    )
    || !samePath(
      exactAbsolutePath(proof.fixtureRoot, 'macos', 'attested macOS fixture root'),
      expected.fixtureRoot,
      'macos',
    )
    || proof.fixtureInitiallyAbsent !== true
    || proof.fixtureCreatedForCurrentRun !== true
    || !samePath(exactAbsolutePath(proof.bundlePath, 'macos', 'macOS bundle path'), installRoot, 'macos')
    || proof.bundleIdentifier !== expected.bundleIdentifier
    || proof.replacementSemantics !== 'tauri-updater-install-returned-current-bundle-observed'
    || proof.installApiReturned !== true
    || proof.currentBundleInstalledAtExpectedPath !== true
    || proof.atomicSwapClaimed !== false
  ) {
    fail('macOS whole-bundle replacement completion proof is invalid');
  }
  for (const [field, label] of [
    ['oldExecutablePath', 'old macOS proof executable'],
    ['currentExecutablePath', 'current macOS proof executable'],
  ]) {
    const actual = exactAbsolutePath(proof[field], 'macos', label);
    if (!samePath(actual, expected[field], 'macos')) fail(`${label} mismatch`);
  }
  validateMacosCodeSignature(proof.oldCodeSignature, expected, previousSha, 'old macOS code signature');
  validateMacosCodeSignature(proof.currentCodeSignature, expected, currentSha, 'current macOS code signature');
}

function validateAuthenticode(signature, expected, label, expectedExecutableSha256 = null) {
  exactKeys(signature, [
    'status', 'signerThumbprint', 'publisher', 'timestampThumbprint', 'executableSha256',
  ], label);
  const executableSha256 = exactSha256(signature.executableSha256, `${label} executable digest`);
  if (
    signature.status !== 'Valid'
    || signature.signerThumbprint !== expected.signerThumbprint
    || signature.publisher !== expected.publisher
    || !/^[A-F0-9]{40}$/u.test(signature.timestampThumbprint ?? '')
    || (expectedExecutableSha256 !== null && executableSha256 !== expectedExecutableSha256)
  ) {
    fail(`${label} does not match the expected Authenticode identity`);
  }
}

export function validateWindowsPlatformProof(
  proof,
  expected,
  installRoot,
  challengeNonce,
  sourceCommit,
  currentVersion,
  updaterArtifactSha256,
  previousSha,
  currentSha,
  harnessProcess,
  previousProcess,
) {
  exactKeys(proof, [
    'kind', 'oldExecutablePath', 'currentExecutablePath', 'updaterTempRoot',
    'updaterTempRootType', 'updaterTempRootNoLink', 'updaterTempRootNoReparsePoint',
    'nsisProcess', 'nsisInvocation', 'nsisExecutableRegularFile', 'nsisExecutableNoLink',
    'nsisExecutableNoReparsePoint', 'nsisExit', 'silent', 'rebootRequired',
    'installerAuthenticode', 'oldExecutableAuthenticode', 'currentExecutableAuthenticode',
    'currentInstalledTree', 'fixtureAcl', 'evidenceAcl',
  ], 'Windows replacement proof');
  const currentInstalledTree = validateWindowsInstalledTreeInventory(
    proof.currentInstalledTree,
    'attested current Windows installed tree',
  );
  const nsisProcess = validateProcessIdentity(
    proof.nsisProcess,
    'windows',
    challengeNonce,
    'Windows NSIS process',
  );
  const fixtureRoot = path.win32.dirname(installRoot);
  validateWindowsEvidenceRootAclObservation(
    proof.fixtureAcl,
    { paths: { evidenceRoot: fixtureRoot } },
  );
  const evidenceRoot = path.win32.join(fixtureRoot, 'evidence');
  validateWindowsEvidenceRootAclObservation(
    proof.evidenceAcl,
    { paths: { evidenceRoot } },
  );
  exactKeys(proof.nsisInvocation, [
    'method', 'parentPid', 'parentOsStartToken', 'parentProcessIdentitySha256',
    'harnessWasNotInvoker',
  ], 'Windows NSIS invocation lineage');
  if (
    proof.kind !== 'windows-nsis-replacement'
    || !samePath(
      exactAbsolutePath(proof.updaterTempRoot, 'windows', 'attested Windows updater temp root'),
      expected.updaterTempRoot,
      'windows',
    )
    || proof.updaterTempRootType !== 'directory'
    || proof.updaterTempRootNoLink !== true
    || proof.updaterTempRootNoReparsePoint !== true
    || !pathIsInside(nsisProcess.canonicalImagePath, expected.updaterTempRoot, 'windows')
    || samePath(nsisProcess.canonicalImagePath, expected.updaterTempRoot, 'windows')
    || path.win32.basename(nsisProcess.canonicalImagePath) !== expected.nsisExecutableFileName
    || samePath(nsisProcess.canonicalImagePath, expected.releaseInstallerPath, 'windows')
    || nsisProcess.imageSha256 !== updaterArtifactSha256
    || nsisProcess.runtimeVersion !== currentVersion
    || nsisProcess.embeddedSourceCommit !== sourceCommit
    || proof.nsisInvocation.method !== 'os-process-start-event-with-parent-start-token'
    || proof.nsisInvocation.parentPid !== previousProcess.pid
    || proof.nsisInvocation.parentOsStartToken !== previousProcess.osStartToken
    || proof.nsisInvocation.parentProcessIdentitySha256
      !== previousProcess.processIdentitySha256
    || proof.nsisInvocation.parentPid === harnessProcess.pid
    || proof.nsisInvocation.parentOsStartToken === harnessProcess.osStartToken
    || proof.nsisInvocation.harnessWasNotInvoker !== true
    || proof.nsisExecutableRegularFile !== true
    || proof.nsisExecutableNoLink !== true
    || proof.nsisExecutableNoReparsePoint !== true
    || proof.silent !== true
    || proof.rebootRequired !== false
    || JSON.stringify(currentInstalledTree) !== JSON.stringify(expected.currentInstalledTree)
  ) {
    fail('Windows NSIS replacement proof is invalid');
  }
  exactKeys(proof.nsisExit, [
    'exited', 'code', 'observedByHarnessProcessIdentitySha256', 'clock',
    'bootMonotonicMs',
  ], 'Windows NSIS exit proof');
  if (
    proof.nsisExit.exited !== true
    || proof.nsisExit.code !== 0
    || proof.nsisExit.observedByHarnessProcessIdentitySha256
      !== harnessProcess.processIdentitySha256
    || proof.nsisExit.clock !== 'system-boot-monotonic-ms'
  ) {
    fail('Windows NSIS exit was not observed by the exact replacement harness');
  }
  nonNegativeInteger(proof.nsisExit.bootMonotonicMs, 'Windows NSIS exit monotonic time');
  for (const [field, label] of [
    ['oldExecutablePath', 'old Windows proof executable'],
    ['currentExecutablePath', 'current Windows proof executable'],
  ]) {
    const actual = exactAbsolutePath(proof[field], 'windows', label);
    if (!samePath(actual, expected[field], 'windows')) fail(`${label} mismatch`);
  }
  validateAuthenticode(
    proof.installerAuthenticode,
    expected,
    'Windows installer Authenticode',
    updaterArtifactSha256,
  );
  validateAuthenticode(proof.oldExecutableAuthenticode, expected, 'old Windows executable Authenticode', previousSha);
  validateAuthenticode(proof.currentExecutableAuthenticode, expected, 'current Windows executable Authenticode', currentSha);
  return nsisProcess;
}
