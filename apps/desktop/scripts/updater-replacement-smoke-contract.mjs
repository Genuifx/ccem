import path from 'node:path';

import {
  UPDATER_REPLACEMENT_PROOF_CLASS,
  UPDATER_REPLACEMENT_TARGETS,
  assertPathInside,
  compareSemver,
  compareText,
  createUpdaterReplacementCefFingerprint,
  exactAbsolutePath,
  exactGitSha,
  exactKeys,
  exactNonEmptyText,
  exactPlatform,
  exactRelativePath,
  exactRunNumber,
  exactSha256,
  exactTarget,
  exactUtcMilliseconds,
  fail,
  hashUpdaterReplacementSmokeJson,
  nonNegativeInteger,
  parseSemver,
  pathIsInside,
  samePath,
  validateProcessIdentity,
  validateSortedUniqueRelativePaths,
} from './updater-replacement-smoke-contract-core.mjs';
import {
  validateMacosPlatformProof,
  validateMacosProofExpectation,
  validateWindowsPlatformProof,
  validateWindowsProofExpectation,
} from './updater-replacement-smoke-contract-platform.mjs';
import {
  UPDATER_REPLACEMENT_FLOW,
  validateUpdaterEvidence,
  validateUpdaterExpectation,
} from './updater-replacement-smoke-contract-transport.mjs';

export {
  UPDATER_REPLACEMENT_PROOF_CLASS,
  UPDATER_REPLACEMENT_TARGETS,
  createUpdaterReplacementCefFingerprint,
  createUpdaterReplacementProcessIdentityFingerprint,
  hashUpdaterReplacementSmokeJson,
} from './updater-replacement-smoke-contract-core.mjs';

export const UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION = 3;
export { UPDATER_REPLACEMENT_FLOW };
export const UPDATER_REPLACEMENT_CLOCK = 'system-boot-monotonic-ms';
export const UPDATER_REPLACEMENT_STAGES = Object.freeze([
  'badSignatureRejected',
  'check',
  'download',
  'installTransition',
  'oldExit',
  'currentStart',
  'currentFinalized',
  'evidenceSealed',
]);
export const UPDATER_REPLACEMENT_STAGE_ACTORS = Object.freeze([
  'previousApp',
  'previousApp',
  'previousApp',
  'previousApp',
  'harness',
  'currentApp',
  'currentApp',
  'harness',
]);

const FIRST_RECEIPT_SHA256 = '0'.repeat(64);
const MAX_CLOCK_DELTA_SKEW_MS = 5_000;
const PROCESS_CENSUS_METHOD = 'os-process-census-by-pid-start-token-image-and-challenge';

function validateRunIdentity(value, label) {
  exactKeys(value, [
    'id', 'attempt', 'repository', 'workflowRef', 'job', 'challengeNonce',
  ], label);
  const repository = exactNonEmptyText(value.repository, `${label} repository`, 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail(`${label} repository must be an exact owner/name`);
  }
  const workflowRef = exactNonEmptyText(value.workflowRef, `${label} workflow ref`, 512);
  if (
    !workflowRef.startsWith(`${repository}/.github/workflows/`)
    || !/\.ya?ml@refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(workflowRef)
  ) {
    fail(`${label} workflow ref must be a repository-bound workflow ref`);
  }
  const job = exactNonEmptyText(value.job, `${label} job`, 100);
  if (!/^[A-Za-z0-9_-]+$/u.test(job)) fail(`${label} job is invalid`);
  return {
    id: exactRunNumber(value.id, `${label} id`),
    attempt: exactRunNumber(value.attempt, `${label} attempt`),
    repository,
    workflowRef,
    job,
    challengeNonce: exactSha256(value.challengeNonce, `${label} challenge nonce`),
  };
}

function validatePreviousIdentity(value) {
  exactKeys(value, [
    'tag', 'sourceCommit', 'version', 'executableSha256', 'instrumentationPatchSha256',
    'embeddedUpdaterPublicKeySha256',
  ], 'previous identity');
  const version = parseSemver(value.version, 'previous version');
  if (value.tag !== `v${value.version}`) fail('previous tag must exactly bind the previous version');
  return {
    tag: value.tag,
    sourceCommit: exactGitSha(value.sourceCommit, 'previous source commit'),
    version: version.value,
    executableSha256: exactSha256(value.executableSha256, 'previous executable digest'),
    instrumentationPatchSha256: exactSha256(
      value.instrumentationPatchSha256,
      'previous-source instrumentation patch digest',
    ),
    embeddedUpdaterPublicKeySha256: exactSha256(
      value.embeddedUpdaterPublicKeySha256,
      'previous embedded updater public key digest',
    ),
    parsedVersion: version,
  };
}

function validateHarnessExpectation(value, platform) {
  exactKeys(value, [
    'canonicalImagePath', 'imageSha256', 'runtimeVersion', 'sourceCommit',
  ], 'replacement harness expectation');
  return {
    canonicalImagePath: exactAbsolutePath(
      value.canonicalImagePath,
      platform,
      'expected harness image path',
    ),
    imageSha256: exactSha256(value.imageSha256, 'expected harness image digest'),
    runtimeVersion: parseSemver(value.runtimeVersion, 'expected harness runtime version').value,
    sourceCommit: exactGitSha(value.sourceCommit, 'expected harness source commit'),
  };
}

function validatePoisonExpectation(value, installRoot, platform) {
  exactKeys(value, ['root', 'absolutePath', 'relativePath', 'sha256'], 'expected poison sentinel');
  const root = exactAbsolutePath(value.root, platform, 'expected poison root');
  const absolutePath = exactAbsolutePath(
    value.absolutePath,
    platform,
    'expected poison absolute path',
  );
  const relativePath = exactRelativePath(
    value.relativePath,
    platform,
    'expected poison relative path',
  );
  assertPathInside(root, installRoot, platform, 'poison root');
  assertPathInside(absolutePath, root, platform, 'poison sentinel');
  const implementation = platform === 'windows' ? path.win32 : path.posix;
  if (!samePath(implementation.join(root, ...relativePath.split('/')), absolutePath, platform)) {
    fail('poison absolute and relative paths do not bind the same file');
  }
  return {
    root,
    absolutePath,
    relativePath,
    sha256: exactSha256(value.sha256, 'expected poison sentinel'),
  };
}

function normalizeExpected(expected) {
  exactKeys(expected, [
    'proofClass', 'platform', 'target', 'run', 'sourceCommit', 'previous', 'harness',
    'currentVersion', 'currentExecutableSha256', 'updater', 'installRoot',
    'poisonSentinel', 'currentCef', 'platformProof',
  ], 'updater replacement expectation');
  if (expected.proofClass !== UPDATER_REPLACEMENT_PROOF_CLASS) {
    fail('updater replacement proof class must be instrumented-previous-source');
  }
  const platform = exactPlatform(expected.platform);
  const target = exactTarget(platform, expected.target);
  const run = validateRunIdentity(expected.run, 'expected run identity');
  const sourceCommit = exactGitSha(expected.sourceCommit, 'expected source commit');
  const previous = validatePreviousIdentity(expected.previous);
  const harness = validateHarnessExpectation(expected.harness, platform);
  const currentVersion = parseSemver(expected.currentVersion, 'current version');
  if (previous.sourceCommit === sourceCommit) fail('previous and current source commits must differ');
  if (harness.sourceCommit !== sourceCommit) fail('harness source commit must bind current source');
  if (compareSemver(previous.parsedVersion, currentVersion) >= 0) {
    fail('current version must be newer than the previous version');
  }
  const currentExecutableSha256 = exactSha256(
    expected.currentExecutableSha256,
    'current executable digest',
  );
  if (previous.executableSha256 === currentExecutableSha256) {
    fail('previous and current executable digests must differ');
  }
  if ([previous.executableSha256, currentExecutableSha256].includes(harness.imageSha256)) {
    fail('replacement harness image must be independent from both app images');
  }
  const updater = validateUpdaterExpectation(expected.updater, platform);
  if (previous.embeddedUpdaterPublicKeySha256 !== updater.publicKeySha256) {
    fail('previous embedded updater public key must verify the current artifact; key rotation requires a separate migration protocol');
  }
  const installRoot = exactAbsolutePath(expected.installRoot, platform, 'expected install root');
  if (platform === 'macos' && !installRoot.endsWith('.app')) {
    fail('macOS install root must be an app bundle');
  }
  if (
    platform === 'macos'
    && (installRoot.toLowerCase() === '/applications'
      || installRoot.toLowerCase().startsWith('/applications/'))
  ) {
    fail('macOS updater fixture must never use /Applications');
  }
  if (pathIsInside(harness.canonicalImagePath, installRoot, platform)) {
    fail('replacement harness image must be outside the install root');
  }
  const poisonSentinel = validatePoisonExpectation(
    expected.poisonSentinel,
    installRoot,
    platform,
  );
  exactKeys(expected.currentCef, ['root', 'files'], 'expected current CEF inventory');
  const cefRoot = exactAbsolutePath(expected.currentCef.root, platform, 'expected current CEF root');
  assertPathInside(cefRoot, installRoot, platform, 'current CEF root');
  const cefFingerprint = createUpdaterReplacementCefFingerprint(expected.currentCef.files, platform);
  if (cefFingerprint.relativePaths.some((candidate) => candidate.toLowerCase() === poisonSentinel.relativePath.toLowerCase())) {
    fail('poison sentinel must not be part of the current CEF inventory');
  }
  const platformProof = platform === 'macos'
    ? validateMacosProofExpectation(expected.platformProof, installRoot, run)
    : validateWindowsProofExpectation(expected.platformProof, installRoot);
  if (
    platform === 'windows'
    && path.win32.basename(platformProof.releaseInstallerPath) !== updater.artifact.fileName
  ) {
    fail('Windows release installer path must bind the exact updater artifact file name');
  }
  return {
    schemaVersion: UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
    proofClass: UPDATER_REPLACEMENT_PROOF_CLASS,
    platform,
    target,
    run,
    sourceCommit,
    previous: {
      tag: previous.tag,
      sourceCommit: previous.sourceCommit,
      version: previous.version,
      executableSha256: previous.executableSha256,
      instrumentationPatchSha256: previous.instrumentationPatchSha256,
      embeddedUpdaterPublicKeySha256: previous.embeddedUpdaterPublicKeySha256,
    },
    harness,
    currentVersion: currentVersion.value,
    currentExecutableSha256,
    updater,
    installRoot,
    poisonSentinel,
    currentCef: {
      root: cefRoot,
      files: cefFingerprint.files,
      pathCount: cefFingerprint.pathCount,
      pathSetSha256: cefFingerprint.pathSetSha256,
      inventorySha256: cefFingerprint.inventorySha256,
    },
    platformProof,
  };
}

export function createUpdaterReplacementContextFingerprint(expected) {
  return hashUpdaterReplacementSmokeJson(normalizeExpected(expected));
}

export function createUpdaterReplacementEvidenceFingerprint(attestation) {
  return hashUpdaterReplacementSmokeJson({
    schemaVersion: attestation.schemaVersion,
    proofClass: attestation.proofClass,
    platform: attestation.platform,
    target: attestation.target,
    contextSha256: attestation.contextSha256,
    run: attestation.run,
    sourceCommit: attestation.sourceCommit,
    previous: attestation.previous,
    currentVersion: attestation.currentVersion,
    currentExecutableSha256: attestation.currentExecutableSha256,
    updater: attestation.updater,
    installation: attestation.installation,
    poisonSentinel: attestation.poisonSentinel,
    currentCef: attestation.currentCef,
    platformProof: attestation.platformProof,
    cleanup: attestation.cleanup,
  });
}

function stageReceiptPayload(stage) {
  return {
    name: stage.name,
    sequence: stage.sequence,
    actor: stage.actor,
    processIdentitySha256: stage.processIdentitySha256,
    clock: stage.clock,
    bootMonotonicMs: stage.bootMonotonicMs,
    wallClockUtc: stage.wallClockUtc,
    evidenceSha256: stage.evidenceSha256,
    contextSha256: stage.contextSha256,
    previousReceiptSha256: stage.previousReceiptSha256,
  };
}

export function sealUpdaterReplacementStageReceipt(stage) {
  exactKeys(stage, [
    'name', 'sequence', 'actor', 'processIdentitySha256', 'clock', 'bootMonotonicMs',
    'wallClockUtc', 'evidenceSha256', 'contextSha256', 'previousReceiptSha256',
  ], 'unsealed updater stage receipt');
  return {
    ...stageReceiptPayload(stage),
    receiptSha256: hashUpdaterReplacementSmokeJson(stageReceiptPayload(stage)),
  };
}

function validateStageReceipts(stages, contextSha256, evidenceSha256, actors, negativeControl) {
  if (!Array.isArray(stages) || stages.length !== UPDATER_REPLACEMENT_STAGES.length) {
    fail('stage receipts are incomplete');
  }
  let previousReceiptSha256 = FIRST_RECEIPT_SHA256;
  let previousBootMonotonicMs = -1;
  let previousWallClockMs = -1;
  stages.forEach((stage, index) => {
    exactKeys(stage, [
      'name', 'sequence', 'actor', 'processIdentitySha256', 'clock', 'bootMonotonicMs',
      'wallClockUtc', 'evidenceSha256', 'contextSha256', 'previousReceiptSha256',
      'receiptSha256',
    ], `stage receipt ${index}`);
    const expectedActor = UPDATER_REPLACEMENT_STAGE_ACTORS[index];
    if (
      stage.name !== UPDATER_REPLACEMENT_STAGES[index]
      || stage.sequence !== index + 1
      || stage.actor !== expectedActor
      || stage.processIdentitySha256 !== actors[expectedActor].processIdentitySha256
      || stage.clock !== UPDATER_REPLACEMENT_CLOCK
    ) {
      fail(`stage receipt ${index} has the wrong order, actor, or process identity`);
    }
    nonNegativeInteger(stage.bootMonotonicMs, `stage ${stage.name} boot monotonic time`);
    exactSha256(stage.evidenceSha256, `stage ${stage.name} evidence`);
    const wallClockMs = exactUtcMilliseconds(stage.wallClockUtc, `stage ${stage.name} wall clock`);
    if (stage.bootMonotonicMs <= previousBootMonotonicMs || wallClockMs <= previousWallClockMs) {
      fail(`stage ${stage.name} timestamp is not strictly increasing`);
    }
    if (index > 0) {
      const monotonicDelta = stage.bootMonotonicMs - previousBootMonotonicMs;
      const wallClockDelta = wallClockMs - previousWallClockMs;
      if (Math.abs(monotonicDelta - wallClockDelta) > MAX_CLOCK_DELTA_SKEW_MS) {
        fail(`stage ${stage.name} wall and monotonic clocks diverge`);
      }
    }
    if (stage.contextSha256 !== contextSha256) fail(`stage ${stage.name} context mismatch`);
    if (stage.previousReceiptSha256 !== previousReceiptSha256) {
      fail(`stage ${stage.name} receipt chain is broken`);
    }
    exactSha256(stage.receiptSha256, `stage ${stage.name} receipt`);
    if (stage.receiptSha256 !== hashUpdaterReplacementSmokeJson(stageReceiptPayload(stage))) {
      fail(`stage ${stage.name} receipt digest mismatch`);
    }
    previousReceiptSha256 = stage.receiptSha256;
    previousBootMonotonicMs = stage.bootMonotonicMs;
    previousWallClockMs = wallClockMs;
  });
  if (stages[0].bootMonotonicMs !== negativeControl.completedBootMonotonicMs) {
    fail('bad-signature negative control is not the first sealed stage');
  }
  if (stages.at(-1).evidenceSha256 !== evidenceSha256) {
    fail('final harness receipt does not seal the complete replacement evidence');
  }
  return previousReceiptSha256;
}

function validatePoisonSentinel(observation, expected, platform) {
  exactKeys(observation, [
    'root', 'rootType', 'rootNoLink', 'rootNoReparsePoint', 'absolutePath',
    'relativePath', 'before', 'after',
  ], 'poison sentinel observation');
  if (
    !samePath(exactAbsolutePath(observation.root, platform, 'observed poison root'), expected.root, platform)
    || observation.rootType !== 'directory'
    || observation.rootNoLink !== true
    || observation.rootNoReparsePoint !== true
    || !samePath(
      exactAbsolutePath(observation.absolutePath, platform, 'observed poison path'),
      expected.absolutePath,
      platform,
    )
    || exactRelativePath(observation.relativePath, platform, 'poison sentinel path') !== expected.relativePath
  ) {
    fail('poison sentinel root or path binding mismatch');
  }
  exactKeys(observation.before, [
    'exists', 'type', 'regularFile', 'noLink', 'noReparsePoint', 'sha256',
  ], 'poison sentinel before observation');
  exactKeys(observation.after, ['exists'], 'poison sentinel after observation');
  if (
    observation.before.exists !== true
    || observation.before.type !== 'file'
    || observation.before.regularFile !== true
    || observation.before.noLink !== true
    || observation.before.noReparsePoint !== true
    || exactSha256(observation.before.sha256, 'poison sentinel before digest') !== expected.sha256
    || observation.after.exists !== false
  ) {
    fail('old CEF poison sentinel was not a regular non-link file removed by replacement');
  }
}

function validateCurrentCef(observation, expected, platform) {
  exactKeys(observation, [
    'root', 'rootType', 'rootNoLink', 'rootNoReparsePoint', 'files', 'pathCount',
    'pathSetSha256', 'inventorySha256', 'scanMethod', 'allEntriesEnumerated',
    'missingPaths', 'extraPaths', 'linkPaths', 'reparsePointPaths', 'adsPaths',
    'reservedNamePaths', 'unsupportedEntries',
  ], 'current CEF observation');
  const root = exactAbsolutePath(observation.root, platform, 'observed current CEF root');
  if (
    !samePath(root, expected.root, platform)
    || observation.rootType !== 'directory'
    || observation.rootNoLink !== true
    || observation.rootNoReparsePoint !== true
    || observation.scanMethod !== (platform === 'windows'
      ? 'immutable-full-install-tree-plus-cef-subset-with-root-reparse-and-ads-enumeration'
      : 'immutable-cef-inventory-recursive-lstat-no-follow')
    || observation.allEntriesEnumerated !== true
  ) {
    fail('current CEF root is not the expected non-link directory');
  }
  const fingerprint = createUpdaterReplacementCefFingerprint(observation.files, platform);
  if (
    observation.pathCount !== expected.pathCount
    || fingerprint.pathCount !== expected.pathCount
    || observation.pathSetSha256 !== expected.pathSetSha256
    || observation.inventorySha256 !== expected.inventorySha256
    || fingerprint.pathSetSha256 !== expected.pathSetSha256
    || fingerprint.inventorySha256 !== expected.inventorySha256
    || JSON.stringify(fingerprint.files) !== JSON.stringify(expected.files)
  ) {
    fail('current CEF inventory is not the exact expected path, type, and digest set');
  }
  for (const [field, label] of [
    ['missingPaths', 'missing'],
    ['extraPaths', 'extra'],
    ['linkPaths', 'link'],
    ['reparsePointPaths', 'reparse-point'],
    ['adsPaths', 'ADS'],
    ['reservedNamePaths', 'reserved-name'],
    ['unsupportedEntries', 'unsupported'],
  ]) {
    const paths = validateSortedUniqueRelativePaths(
      observation[field],
      platform,
      `current CEF ${label} paths`,
    );
    if (paths.length !== 0) fail(`current CEF inventory contains ${label} paths`);
  }
}

function sortedCensusIdentities(values) {
  return [...values].sort((left, right) => compareText(
    left.processIdentitySha256,
    right.processIdentitySha256,
  ));
}

function validateCleanup(cleanup, platform, challengeNonce, installRoot, requiredProcesses) {
  exactKeys(cleanup, [
    'scope', 'method', 'challengeNonce', 'observedProcesses',
    'remainingOwnedProcesses', 'residueCount',
  ], 'owned process cleanup');
  if (
    cleanup.scope !== 'replaced-installation-process-tree-and-descendants'
    || cleanup.method !== PROCESS_CENSUS_METHOD
    || cleanup.challengeNonce !== challengeNonce
    || !Array.isArray(cleanup.observedProcesses)
    || !Array.isArray(cleanup.remainingOwnedProcesses)
  ) {
    fail('owned process cleanup must use the challenge-bound OS process census');
  }
  const observed = cleanup.observedProcesses.map((value, index) => (
    validateProcessIdentity(value, platform, challengeNonce, `owned process census ${index}`)
  ));
  const sortedObserved = sortedCensusIdentities(observed);
  if (JSON.stringify(observed) !== JSON.stringify(sortedObserved)) {
    fail('owned process census must be sorted by process identity and duplicate-free');
  }
  if (
    new Set(observed.map((value) => value.processIdentitySha256)).size !== observed.length
    || new Set(observed.map((value) => value.pid)).size !== observed.length
    || new Set(observed.map((value) => value.osStartToken)).size !== observed.length
  ) {
    fail('owned process census must be sorted by process identity and duplicate-free');
  }
  const observedIdentities = new Set(observed.map((value) => value.processIdentitySha256));
  if (requiredProcesses.some((value) => !observedIdentities.has(value.processIdentitySha256))) {
    fail('owned process census is missing an exact start-token and image-bound process');
  }
  const allowedExternalImages = new Set(requiredProcesses
    .filter((value) => !pathIsInside(value.canonicalImagePath, installRoot, platform))
    .map((value) => value.canonicalImagePath.toLowerCase()));
  if (observed.some((value) => (
    !pathIsInside(value.canonicalImagePath, installRoot, platform)
    && !allowedExternalImages.has(value.canonicalImagePath.toLowerCase())
  ))) {
    fail('owned process census contains an image outside the replacement process tree');
  }
  if (cleanup.remainingOwnedProcesses.length !== 0 || cleanup.residueCount !== 0) {
    fail('owned updater process residue is not zero');
  }
}

function validateAppProcess(process, platform, challengeNonce, expected, label) {
  const identity = validateProcessIdentity(process, platform, challengeNonce, label);
  if (
    !samePath(identity.canonicalImagePath, expected.canonicalImagePath, platform)
    || identity.imageSha256 !== expected.imageSha256
    || identity.runtimeVersion !== expected.runtimeVersion
    || identity.embeddedSourceCommit !== expected.sourceCommit
  ) {
    fail(`${label} does not match the expected executable runtime identity`);
  }
  return identity;
}

export function validateUpdaterReplacementSmokeAttestation(attestation, expected) {
  const normalizedExpected = normalizeExpected(expected);
  const contextSha256 = hashUpdaterReplacementSmokeJson(normalizedExpected);
  exactKeys(attestation, [
    'schemaVersion', 'proofClass', 'platform', 'target', 'contextSha256', 'evidenceSha256',
    'run', 'sourceCommit', 'previous', 'currentVersion', 'currentExecutableSha256',
    'updater', 'installation', 'stages', 'poisonSentinel', 'currentCef',
    'platformProof', 'cleanup',
  ], 'updater replacement smoke attestation');
  if (attestation.schemaVersion !== UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION) fail('attestation schema version mismatch');
  if (attestation.proofClass !== UPDATER_REPLACEMENT_PROOF_CLASS) fail('attestation proof class mismatch');
  if (attestation.platform !== normalizedExpected.platform) fail('attestation platform mismatch');
  if (attestation.target !== normalizedExpected.target) fail('attestation target mismatch');
  if (attestation.contextSha256 !== contextSha256) fail('attestation context fingerprint mismatch');
  const evidenceSha256 = exactSha256(attestation.evidenceSha256, 'complete replacement evidence digest');
  const run = validateRunIdentity(attestation.run, 'attested run identity');
  if (JSON.stringify(run) !== JSON.stringify(normalizedExpected.run)) {
    fail('attestation current run identity mismatch');
  }
  if (attestation.sourceCommit !== normalizedExpected.sourceCommit) fail('attestation source commit mismatch');
  exactKeys(attestation.previous, [
    'tag', 'sourceCommit', 'version', 'executableSha256', 'instrumentationPatchSha256',
    'embeddedUpdaterPublicKeySha256',
  ], 'attested previous identity');
  if (JSON.stringify(attestation.previous) !== JSON.stringify(normalizedExpected.previous)) {
    fail('attestation previous identity mismatch');
  }
  if (attestation.currentVersion !== normalizedExpected.currentVersion) fail('attestation current version mismatch');
  if (attestation.currentExecutableSha256 !== normalizedExpected.currentExecutableSha256) {
    fail('attestation current executable digest mismatch');
  }
  exactKeys(attestation.installation, [
    'root', 'previousProcess', 'harnessProcess', 'currentProcess',
  ], 'replacement installation');
  const installRoot = exactAbsolutePath(
    attestation.installation.root,
    normalizedExpected.platform,
    'attested install root',
  );
  if (!samePath(installRoot, normalizedExpected.installRoot, normalizedExpected.platform)) {
    fail('attested install root mismatch');
  }
  const challengeNonce = normalizedExpected.run.challengeNonce;
  const previousProcess = validateAppProcess(
    attestation.installation.previousProcess,
    normalizedExpected.platform,
    challengeNonce,
    {
      canonicalImagePath: normalizedExpected.platformProof.oldExecutablePath,
      imageSha256: normalizedExpected.previous.executableSha256,
      runtimeVersion: normalizedExpected.previous.version,
      sourceCommit: normalizedExpected.previous.sourceCommit,
    },
    'previous app process',
  );
  const harnessProcess = validateAppProcess(
    attestation.installation.harnessProcess,
    normalizedExpected.platform,
    challengeNonce,
    normalizedExpected.harness,
    'replacement harness process',
  );
  const currentProcess = validateAppProcess(
    attestation.installation.currentProcess,
    normalizedExpected.platform,
    challengeNonce,
    {
      canonicalImagePath: normalizedExpected.platformProof.currentExecutablePath,
      imageSha256: normalizedExpected.currentExecutableSha256,
      runtimeVersion: normalizedExpected.currentVersion,
      sourceCommit: normalizedExpected.sourceCommit,
    },
    'current app process',
  );
  if (
    new Set([previousProcess.pid, harnessProcess.pid, currentProcess.pid]).size !== 3
    || new Set([
      previousProcess.osStartToken,
      harnessProcess.osStartToken,
      currentProcess.osStartToken,
    ]).size !== 3
    || new Set([
      previousProcess.processIdentitySha256,
      harnessProcess.processIdentitySha256,
      currentProcess.processIdentitySha256,
    ]).size !== 3
  ) {
    fail('previous app, harness, and current app process identities must differ');
  }
  const negativeControl = validateUpdaterEvidence(
    attestation.updater,
    normalizedExpected.updater,
    challengeNonce,
    previousProcess,
  );
  validatePoisonSentinel(
    attestation.poisonSentinel,
    normalizedExpected.poisonSentinel,
    normalizedExpected.platform,
  );
  validateCurrentCef(
    attestation.currentCef,
    normalizedExpected.currentCef,
    normalizedExpected.platform,
  );
  let nsisProcess = null;
  if (normalizedExpected.platform === 'macos') {
    validateMacosPlatformProof(
      attestation.platformProof,
      normalizedExpected.platformProof,
      installRoot,
      normalizedExpected.previous.executableSha256,
      normalizedExpected.currentExecutableSha256,
    );
  } else {
    nsisProcess = validateWindowsPlatformProof(
      attestation.platformProof,
      normalizedExpected.platformProof,
      installRoot,
      challengeNonce,
      normalizedExpected.sourceCommit,
      normalizedExpected.currentVersion,
      normalizedExpected.updater.artifact.sha256,
      normalizedExpected.previous.executableSha256,
      normalizedExpected.currentExecutableSha256,
      harnessProcess,
      previousProcess,
    );
    if (
      [previousProcess.pid, harnessProcess.pid, currentProcess.pid].includes(nsisProcess.pid)
      || [
        previousProcess.osStartToken,
        harnessProcess.osStartToken,
        currentProcess.osStartToken,
      ].includes(nsisProcess.osStartToken)
    ) {
      fail('Windows NSIS process identity must differ from apps and harness');
    }
  }
  validateCleanup(
    attestation.cleanup,
    normalizedExpected.platform,
    challengeNonce,
    installRoot,
    nsisProcess === null
      ? [previousProcess, currentProcess]
      : [previousProcess, nsisProcess, currentProcess],
  );
  if (evidenceSha256 !== createUpdaterReplacementEvidenceFingerprint(attestation)) {
    fail('complete replacement evidence digest mismatch');
  }
  const finalStageReceiptSha256 = validateStageReceipts(
    attestation.stages,
    contextSha256,
    evidenceSha256,
    { previousApp: previousProcess, harness: harnessProcess, currentApp: currentProcess },
    negativeControl,
  );
  if (
    nsisProcess !== null
    && (
      attestation.platformProof.nsisExit.bootMonotonicMs
        <= attestation.stages[3].bootMonotonicMs
      || attestation.platformProof.nsisExit.bootMonotonicMs
        > attestation.stages[5].bootMonotonicMs
    )
  ) {
    fail('Windows NSIS exit must occur after install transition and before current start');
  }
  const summary = {
    schemaVersion: UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
    proofClass: UPDATER_REPLACEMENT_PROOF_CLASS,
    platform: normalizedExpected.platform,
    target: normalizedExpected.target,
    runId: normalizedExpected.run.id,
    runAttempt: normalizedExpected.run.attempt,
    repository: normalizedExpected.run.repository,
    workflowRef: normalizedExpected.run.workflowRef,
    job: normalizedExpected.run.job,
    challengeNonce: normalizedExpected.run.challengeNonce,
    sourceCommit: normalizedExpected.sourceCommit,
    previousTag: normalizedExpected.previous.tag,
    previousSourceCommit: normalizedExpected.previous.sourceCommit,
    previousVersion: normalizedExpected.previous.version,
    previousExecutableSha256: normalizedExpected.previous.executableSha256,
    instrumentationPatchSha256: normalizedExpected.previous.instrumentationPatchSha256,
    previousEmbeddedUpdaterPublicKeySha256:
      normalizedExpected.previous.embeddedUpdaterPublicKeySha256,
    currentVersion: normalizedExpected.currentVersion,
    currentExecutableSha256: normalizedExpected.currentExecutableSha256,
    updaterPublicKeySha256: normalizedExpected.updater.publicKeySha256,
    updaterArtifactSha256: normalizedExpected.updater.artifact.sha256,
    updaterSignatureSha256: normalizedExpected.updater.signature.sha256,
    transportOrigin: normalizedExpected.updater.transport.origin,
    installRoot: normalizedExpected.installRoot,
    previousProcessIdentitySha256: previousProcess.processIdentitySha256,
    harnessProcessIdentitySha256: harnessProcess.processIdentitySha256,
    currentProcessIdentitySha256: currentProcess.processIdentitySha256,
    stages: [...UPDATER_REPLACEMENT_STAGES],
    finalStageReceiptSha256,
    evidenceSha256,
    badSignatureRejectedWithoutMutation: true,
    poisonSentinelRemoved: true,
    cefPathCount: normalizedExpected.currentCef.pathCount,
    cefPathSetSha256: normalizedExpected.currentCef.pathSetSha256,
    cefInventorySha256: normalizedExpected.currentCef.inventorySha256,
    platformProofKind: attestation.platformProof.kind,
    processResidueZero: true,
    attestationSha256: hashUpdaterReplacementSmokeJson(attestation),
  };
  if (normalizedExpected.platform === 'windows') {
    Object.assign(summary, {
      fixtureAclRestricted: true,
      evidenceAclRestricted: true,
      installedTreePathCount: normalizedExpected.platformProof.currentInstalledTree.pathCount,
      installedTreePathSetSha256:
        normalizedExpected.platformProof.currentInstalledTree.pathSetSha256,
      installedTreeInventorySha256:
        normalizedExpected.platformProof.currentInstalledTree.inventorySha256,
    });
  }
  return summary;
}
