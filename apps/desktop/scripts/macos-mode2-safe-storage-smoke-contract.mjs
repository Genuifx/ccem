import path from 'node:path';

export const MACOS_SAFE_STORAGE_SMOKE_SCHEMA_VERSION = 1;
export const MACOS_SAFE_STORAGE_SMOKE_ALLOW_ENV =
  'CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ALLOW';
export const MACOS_SAFE_STORAGE_SMOKE_NONCE_ENV =
  'CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_NONCE';
export const MACOS_SAFE_STORAGE_SMOKE_ROOT_ENV =
  'CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ROOT';
export const MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV =
  'CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ATTESTATION';
export const MACOS_SAFE_STORAGE_SMOKE_DIRECTORY =
  'ccem-mode2-safe-storage-smoke';
export const MACOS_SAFE_STORAGE_SCENARIOS = ['clean', 'generic-conflict'];
export const MACOS_SAFE_STORAGE_PHASES = ['prime', 'verify'];
export const MACOS_SAFE_STORAGE_SERVICE = 'CCEM Safe Storage';
export const CHROMIUM_SAFE_STORAGE_SERVICE = 'Chromium Safe Storage';

const REQUIRED_RUNTIME_STAGES = [
  'ready',
  'cookie_verified',
  'hidden',
  'shown',
  'closed',
  'reopened',
  'reopened_cookie_verified',
  'reclosed',
];

function fail(message) {
  throw new Error(`[macos-mode2-safe-storage-smoke-contract] ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields differ: ${actual.join(', ')}`);
  }
  return value;
}

function exactLowerHex(value, length, label) {
  if (
    typeof value !== 'string'
    || value.length !== length
    || !value.split('').every((character) => /[0-9a-f]/u.test(character))
  ) {
    fail(`${label} must be ${length} lowercase hexadecimal characters`);
  }
  return value;
}

function exactRunNumber(value, label) {
  if (!/^[1-9][0-9]{0,19}$/u.test(value ?? '')) {
    fail(`${label} must be a positive canonical run number`);
  }
  return value;
}

function normalizedAbsolutePath(value, label) {
  if (
    typeof value !== 'string'
    || !path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.includes('\0')
  ) {
    fail(`${label} must be a normalized absolute macOS path`);
  }
  return value;
}

function samePath(left, right) {
  return path.posix.normalize(left) === path.posix.normalize(right);
}

export function expectedMacosSafeStorageSmokeRoot(environment) {
  const runnerTemp = normalizedAbsolutePath(environment.RUNNER_TEMP, 'RUNNER_TEMP');
  const runId = exactRunNumber(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID');
  const runAttempt = exactRunNumber(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT');
  const nonce = exactLowerHex(
    environment[MACOS_SAFE_STORAGE_SMOKE_NONCE_ENV],
    64,
    MACOS_SAFE_STORAGE_SMOKE_NONCE_ENV,
  );
  return path.posix.join(
    runnerTemp,
    MACOS_SAFE_STORAGE_SMOKE_DIRECTORY,
    `${runId}-${runAttempt}-${nonce.slice(0, 16)}`,
  );
}

export function createMacosSafeStorageSmokePlan({ environment, sourceApp }) {
  const smokeRoot = expectedMacosSafeStorageSmokeRoot(environment);
  const configuredRoot = normalizedAbsolutePath(
    environment[MACOS_SAFE_STORAGE_SMOKE_ROOT_ENV],
    MACOS_SAFE_STORAGE_SMOKE_ROOT_ENV,
  );
  if (!samePath(configuredRoot, smokeRoot)) {
    fail(`${MACOS_SAFE_STORAGE_SMOKE_ROOT_ENV} is not the exact current-run root`);
  }
  const attestationPath = path.posix.join(smokeRoot, 'evidence', 'attestation.json');
  const configuredAttestation = normalizedAbsolutePath(
    environment[MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV],
    MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV,
  );
  if (!samePath(configuredAttestation, attestationPath)) {
    fail(`${MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV} escaped the exact evidence root`);
  }

  const sourceAppPath = normalizedAbsolutePath(sourceApp, 'source app');
  if (
    sourceAppPath === '/Applications'
    || sourceAppPath.startsWith('/Applications/')
    || !sourceAppPath.endsWith('.app')
  ) {
    fail('source app must be a runner-built .app outside /Applications');
  }
  const installedApp = path.posix.join(smokeRoot, 'app', 'CCEM.app');
  const executable = path.posix.join(installedApp, 'Contents', 'MacOS', 'ccem-desktop');
  const framework = path.posix.join(
    installedApp,
    'Contents',
    'Frameworks',
    'Chromium Embedded Framework.framework',
    'Chromium Embedded Framework',
  );

  return {
    schemaVersion: MACOS_SAFE_STORAGE_SMOKE_SCHEMA_VERSION,
    sourceCommit: exactLowerHex(environment.GITHUB_SHA, 40, 'GITHUB_SHA'),
    nonce: environment[MACOS_SAFE_STORAGE_SMOKE_NONCE_ENV],
    run: {
      id: exactRunNumber(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
      attempt: exactRunNumber(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
    },
    paths: {
      smokeRoot,
      sourceApp: sourceAppPath,
      installedApp,
      executable,
      framework,
      evidenceRoot: path.posix.dirname(attestationPath),
      attestationPath,
    },
    scenarios: MACOS_SAFE_STORAGE_SCENARIOS.map((scenario) => ({
      name: scenario,
      root: path.posix.join(smokeRoot, 'scenarios', scenario),
      keychain: path.posix.join(smokeRoot, 'scenarios', scenario, 'keychain', 'smoke.keychain-db'),
      cacheRoot: path.posix.join(smokeRoot, 'scenarios', scenario, 'data', 'login', 'cef'),
      receipts: Object.fromEntries(MACOS_SAFE_STORAGE_PHASES.map((phase) => [
        phase,
        path.posix.join(smokeRoot, 'scenarios', scenario, 'evidence', `${phase}-runtime.json`),
      ])),
    })),
  };
}

function validateRuntimeStages(stages) {
  if (!Array.isArray(stages) || stages.length !== REQUIRED_RUNTIME_STAGES.length) {
    fail('runtime stage count is invalid');
  }
  let previous = -1;
  for (let index = 0; index < REQUIRED_RUNTIME_STAGES.length; index += 1) {
    const stage = exactKeys(stages[index], ['name', 'monotonicMs'], 'runtime stage');
    if (
      stage.name !== REQUIRED_RUNTIME_STAGES[index]
      || !Number.isSafeInteger(stage.monotonicMs)
      || stage.monotonicMs <= previous
    ) {
      fail('runtime stages are missing, out of order, or non-monotonic');
    }
    previous = stage.monotonicMs;
  }
}

export function validateMacosSafeStorageRuntimeReceipt(receipt, plan, scenario, phase) {
  exactKeys(receipt, [
    'schemaVersion', 'smoke', 'status', 'exitCode', 'error', 'nonce', 'sourceCommit',
    'runId', 'runAttempt', 'scenario', 'phase', 'appVersion', 'mainPid',
    'executablePath', 'smokeRoot', 'cefCacheRoot', 'profileId', 'surfaceId',
    'credentialStore', 'safeStorageService', 'systemKeychainMarkerVerified',
    'distributionSignatureVerified', 'safeStorageBrandingVerified', 'persistentCookieVerified',
    'persistentProfileStorage', 'normalStartupBypassed', 'sandboxEnabled', 'stages',
  ], 'runtime receipt');
  const scenarioPlan = plan.scenarios.find((entry) => entry.name === scenario);
  if (!scenarioPlan || !MACOS_SAFE_STORAGE_PHASES.includes(phase)) {
    fail('runtime scenario or phase is not in the plan');
  }
  if (
    receipt.schemaVersion !== MACOS_SAFE_STORAGE_SMOKE_SCHEMA_VERSION
    || receipt.smoke !== 'macos-mode2-safe-storage-release'
    || receipt.status !== 'passed'
    || receipt.exitCode !== 0
    || receipt.error !== null
    || receipt.nonce !== plan.nonce
    || receipt.sourceCommit !== plan.sourceCommit
    || receipt.runId !== plan.run.id
    || receipt.runAttempt !== plan.run.attempt
    || receipt.scenario !== scenario
    || receipt.phase !== phase
    || receipt.executablePath !== plan.paths.executable
    || receipt.smokeRoot !== scenarioPlan.root
    || receipt.cefCacheRoot !== scenarioPlan.cacheRoot
    || receipt.credentialStore !== 'macos-system-keychain-v2'
    || receipt.safeStorageService !== MACOS_SAFE_STORAGE_SERVICE
    || receipt.distributionSignatureVerified !== true
    || receipt.safeStorageBrandingVerified !== true
    || receipt.systemKeychainMarkerVerified !== true
    || receipt.persistentCookieVerified !== true
    || receipt.persistentProfileStorage !== true
    || receipt.normalStartupBypassed !== true
    || receipt.sandboxEnabled !== true
    || !Number.isSafeInteger(receipt.mainPid)
    || receipt.mainPid <= 0
    || typeof receipt.appVersion !== 'string'
    || receipt.appVersion.length === 0
    || receipt.profileId !== `safe-storage-${scenario}-${plan.nonce.slice(0, 24)}`
    || receipt.surfaceId !== `mode2-safe-storage-${scenario}-${phase}-${plan.nonce.slice(0, 12)}`
  ) {
    fail('runtime receipt is not bound to the signed current-run system-Keychain smoke');
  }
  validateRuntimeStages(receipt.stages);
  return receipt;
}

export function validateMacosSafeStorageSmokeAttestation(attestation, plan) {
  exactKeys(attestation, [
    'schemaVersion', 'platform', 'status', 'sourceCommit', 'nonce', 'run',
    'app', 'safeStorageBranding', 'scenarios', 'cleanup',
  ], 'attestation');
  if (
    attestation.schemaVersion !== MACOS_SAFE_STORAGE_SMOKE_SCHEMA_VERSION
    || attestation.platform !== 'macos'
    || attestation.status !== 'passed'
    || attestation.sourceCommit !== plan.sourceCommit
    || attestation.nonce !== plan.nonce
    || JSON.stringify(attestation.run) !== JSON.stringify(plan.run)
  ) {
    fail('attestation identity is invalid');
  }
  exactKeys(attestation.app, [
    'bundlePath', 'executablePath', 'executableSha256', 'frameworkSha256', 'signatureVerified',
  ], 'attestation app');
  if (
    attestation.app.bundlePath !== plan.paths.installedApp
    || attestation.app.executablePath !== plan.paths.executable
    || !/^[a-f0-9]{64}$/u.test(attestation.app.executableSha256)
    || !/^[a-f0-9]{64}$/u.test(attestation.app.frameworkSha256)
    || attestation.app.signatureVerified !== true
  ) {
    fail('attestation app identity is invalid');
  }
  exactKeys(attestation.safeStorageBranding, [
    'service', 'genericServiceAbsentFromFramework', 'uniqueBrandedSlot',
  ], 'Safe Storage branding');
  if (
    attestation.safeStorageBranding.service !== MACOS_SAFE_STORAGE_SERVICE
    || attestation.safeStorageBranding.genericServiceAbsentFromFramework !== true
    || attestation.safeStorageBranding.uniqueBrandedSlot !== true
  ) {
    fail('Safe Storage branding proof is invalid');
  }
  if (!Array.isArray(attestation.scenarios) || attestation.scenarios.length !== 2) {
    fail('attestation must contain both Safe Storage scenarios');
  }
  for (const scenario of MACOS_SAFE_STORAGE_SCENARIOS) {
    const entry = attestation.scenarios.find((candidate) => candidate.name === scenario);
    exactKeys(entry, [
      'name', 'genericItemSeeded', 'genericItemPresentAfter', 'ccemItemPresentAfter',
      'genericItemUnchanged', 'exclusiveTemporaryKeychain', 'launchCount', 'receipts',
      'ownedProcessesAfter',
    ], `scenario ${scenario}`);
    if (
      entry.name !== scenario
      || entry.genericItemSeeded !== (scenario === 'generic-conflict')
      || entry.genericItemPresentAfter !== (scenario === 'generic-conflict')
      || entry.genericItemUnchanged !== true
      || entry.ccemItemPresentAfter !== true
      || entry.exclusiveTemporaryKeychain !== true
      || entry.launchCount !== 2
      || entry.ownedProcessesAfter !== 0
    ) {
      fail(`scenario ${scenario} did not prove isolated two-launch behavior`);
    }
    exactKeys(entry.receipts, MACOS_SAFE_STORAGE_PHASES, `scenario ${scenario} receipts`);
    for (const phase of MACOS_SAFE_STORAGE_PHASES) {
      validateMacosSafeStorageRuntimeReceipt(entry.receipts[phase], plan, scenario, phase);
    }
    if (
      entry.receipts.prime.profileId !== entry.receipts.verify.profileId
      || entry.receipts.prime.appVersion !== entry.receipts.verify.appVersion
    ) {
      fail(`scenario ${scenario} did not reopen the same persistent profile and app build`);
    }
  }
  exactKeys(attestation.cleanup, [
    'originalKeychainStateRestored', 'temporaryKeychainsDeleted',
    'scenarioRootsDeleted', 'installedAppDeleted',
  ], 'cleanup');
  if (!Object.values(attestation.cleanup).every((value) => value === true)) {
    fail('temporary Keychain, process, app, or profile cleanup is incomplete');
  }
  return attestation;
}

const MACOS_SAFE_STORAGE_RELEASE_SUMMARY_FIELDS = [
  'schemaVersion',
  'platform',
  'status',
  'sourceCommit',
  'appVersion',
  'runId',
  'runAttempt',
  'attestationSha256',
  'executableSha256',
  'frameworkSha256',
  'safeStorageService',
  'credentialStore',
  'scenarios',
  'launchCount',
  'cleanKeychainVerified',
  'genericConflictIsolationVerified',
  'cookiePersistenceVerified',
  'keychainStateRestored',
  'cleanupVerified',
];

function exactMacTarget(value) {
  if (!/^(?:aarch64|x86_64)-apple-darwin$/u.test(value ?? '')) {
    fail('release summary platform is not a supported macOS target');
  }
  return value;
}

function exactAppVersion(value) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(value ?? '')) {
    fail('release summary app version is invalid');
  }
  return value;
}

export function createMacosSafeStorageReleaseSummary(attestation, plan, {
  target,
  appVersion,
  attestationSha256,
  executableSha256,
  frameworkSha256,
}) {
  validateMacosSafeStorageSmokeAttestation(attestation, plan);
  exactMacTarget(target);
  exactAppVersion(appVersion);
  for (const digest of [attestationSha256, executableSha256, frameworkSha256]) {
    exactLowerHex(digest, 64, 'release summary digest');
  }
  if (
    attestation.app.executableSha256 !== executableSha256
    || attestation.app.frameworkSha256 !== frameworkSha256
    || attestation.scenarios.some((scenario) => MACOS_SAFE_STORAGE_PHASES.some(
      (phase) => scenario.receipts[phase].appVersion !== appVersion,
    ))
  ) {
    fail('Safe Storage attestation does not bind the exact release app bytes and version');
  }
  return {
    schemaVersion: MACOS_SAFE_STORAGE_SMOKE_SCHEMA_VERSION,
    platform: target,
    status: 'passed',
    sourceCommit: plan.sourceCommit,
    appVersion,
    runId: plan.run.id,
    runAttempt: plan.run.attempt,
    attestationSha256,
    executableSha256,
    frameworkSha256,
    safeStorageService: MACOS_SAFE_STORAGE_SERVICE,
    credentialStore: 'macos-system-keychain-v2',
    scenarios: [...MACOS_SAFE_STORAGE_SCENARIOS],
    launchCount: MACOS_SAFE_STORAGE_SCENARIOS.length * MACOS_SAFE_STORAGE_PHASES.length,
    cleanKeychainVerified: true,
    genericConflictIsolationVerified: true,
    cookiePersistenceVerified: true,
    keychainStateRestored: true,
    cleanupVerified: true,
  };
}

export function validateMacosSafeStorageReleaseSummary(summary, {
  target,
  sourceCommit,
  appVersion,
  executableSha256,
  frameworkSha256,
}) {
  exactKeys(summary, MACOS_SAFE_STORAGE_RELEASE_SUMMARY_FIELDS, 'release summary');
  exactMacTarget(target);
  exactAppVersion(appVersion);
  if (
    summary.schemaVersion !== MACOS_SAFE_STORAGE_SMOKE_SCHEMA_VERSION
    || summary.platform !== target
    || summary.status !== 'passed'
    || summary.sourceCommit !== sourceCommit
    || summary.appVersion !== appVersion
    || !/^[1-9][0-9]{0,19}$/u.test(summary.runId ?? '')
    || !/^[1-9][0-9]{0,19}$/u.test(summary.runAttempt ?? '')
    || !/^[a-f0-9]{64}$/u.test(summary.attestationSha256 ?? '')
    || summary.executableSha256 !== executableSha256
    || summary.frameworkSha256 !== frameworkSha256
    || summary.safeStorageService !== MACOS_SAFE_STORAGE_SERVICE
    || summary.credentialStore !== 'macos-system-keychain-v2'
    || JSON.stringify(summary.scenarios) !== JSON.stringify(MACOS_SAFE_STORAGE_SCENARIOS)
    || summary.launchCount !== 4
    || summary.cleanKeychainVerified !== true
    || summary.genericConflictIsolationVerified !== true
    || summary.cookiePersistenceVerified !== true
    || summary.keychainStateRestored !== true
    || summary.cleanupVerified !== true
  ) {
    fail('release summary does not prove the signed current-target Safe Storage runtime path');
  }
  return { ...summary };
}

export { REQUIRED_RUNTIME_STAGES as MACOS_SAFE_STORAGE_REQUIRED_RUNTIME_STAGES };
