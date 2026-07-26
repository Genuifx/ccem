import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  WINDOWS_MODE2_SMOKE_PLATFORM,
  WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
  createWindowsMode2GithubRunIdentity,
  createWindowsRuntimeInventoryFingerprint,
  expectedWindowsMode2EvidenceRoot,
  expectedWindowsMode2InstallRoot,
  expectedWindowsMode2SmokeRoot,
  hashWindowsMode2SmokeJson,
  validateWindowsNativeWindowObservation,
  validateWindowsMode2ProductionSmokeAttestation,
  validateWindowsMode2SmokeSummary,
  validateWindowsProcessSandboxEvidence,
} from './windows-mode2-production-smoke-contract.mjs';
import {
  WINDOWS_POWERSHELL_PATH,
  createWindowsEvidenceRootAclCommand,
  createWindowsOwnedProcessCommand,
  createWindowsPreflightInspectionCommand,
  createWindowsProcessObservationCommand,
  createWindowsUpgradeAclSeedCommand,
  validatePreflightObservation,
  validateWindowsEvidenceRootAclObservation,
  validateWindowsUpgradeAclSeedObservation,
} from './windows-mode2-production-smoke-inspection.mjs';
import { WINDOWS_CEF_SOURCE_PIN } from './stage-cef-windows.mjs';

export {
  WINDOWS_POWERSHELL_PATH,
  createWindowsEvidenceRootAclCommand,
  createWindowsOwnedProcessCommand,
  createWindowsPreflightInspectionCommand,
  createWindowsProcessObservationCommand,
  createWindowsUpgradeAclSeedCommand,
  validatePreflightObservation,
  validateWindowsEvidenceRootAclObservation,
  validateWindowsUpgradeAclSeedObservation,
};

export const WINDOWS_MODE2_SMOKE_ALLOW_ENV = 'CCEM_WINDOWS_MODE2_ALLOW_PRODUCTION_SMOKE';
export const WINDOWS_MODE2_SMOKE_MANIFEST = 'cef-windows-staging-manifest.json';
export const WINDOWS_MODE2_SMOKE_EXECUTABLE = 'ccem-desktop.exe';
export const WINDOWS_MODE2_SMOKE_ATTESTATION = 'windows-mode2-production-smoke-attestation.json';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

const scriptPath = fileURLToPath(import.meta.url);

function fail(message) {
  throw new Error(`[windows-mode2-smoke-runner] ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields differ: ${actual.join(', ')}`);
  }
  return value;
}

function exactWindowsPath(value, label) {
  if (
    typeof value !== 'string'
    || !path.win32.isAbsolute(value)
    || value.includes('\0')
    || path.win32.normalize(value) !== value
  ) {
    fail(`${label} must be a normalized absolute Windows path`);
  }
  return value;
}

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function exactGitSha(value, label = 'source commit') {
  if (!/^[a-f0-9]{40}$/u.test(value ?? '')) fail(`${label} must be an exact Git SHA`);
  return value;
}

function exactSha256(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? '')) fail(`${label} must be an exact SHA-256`);
  return value;
}

function exactNonce(value) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? '')) fail('smoke nonce must be 32 random bytes');
  return value;
}

function exactAppVersion(value) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(value ?? '')) {
    fail('app version is missing or invalid');
  }
  return value;
}

function timeoutValue(value) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 600_000) {
    fail('timeout must be an integer between 1000 and 600000 milliseconds');
  }
  return value;
}

function exactRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\\')
    || value.startsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    fail(`${label} is not a safe forward-slash relative path`);
  }
  return value;
}

function normalizeThumbprint(value) {
  const normalized = (value ?? '').replaceAll(/\s/g, '').toUpperCase();
  if (!/^[A-F0-9]{40}$/u.test(normalized)) fail('Windows signer thumbprint is invalid');
  return normalized;
}

function exactPublisher(value) {
  if (!/^CN=[^,]+(?:,\s*(?:O|OU|L|S|C)=[^,]+)*$/u.test(value ?? '')) {
    fail('Windows signer publisher is invalid');
  }
  return value;
}

export function assertWindowsMode2SmokeAuthorization(
  environment = process.env,
  platform = process.platform,
) {
  if (
    platform !== 'win32'
    || environment.GITHUB_ACTIONS !== 'true'
    || environment.RUNNER_OS !== 'Windows'
    || environment[WINDOWS_MODE2_SMOKE_ALLOW_ENV] !== '1'
  ) {
    fail('real smoke is allowed only on an explicitly authorized GitHub Actions Windows runner');
  }
  return true;
}

export function createWindowsMode2SmokePlan({
  environment,
  installerPath,
  stageDir,
  appVersion,
  sourceCommit,
  outputPath,
  nonce = randomBytes(32).toString('hex'),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const run = createWindowsMode2GithubRunIdentity(environment);
  const smokeRoot = expectedWindowsMode2SmokeRoot(environment);
  const installRoot = expectedWindowsMode2InstallRoot(environment);
  const evidenceRoot = expectedWindowsMode2EvidenceRoot(environment);
  const exactOutput = path.win32.join(evidenceRoot, WINDOWS_MODE2_SMOKE_ATTESTATION);
  const requestedOutput = outputPath === undefined
    ? exactOutput
    : exactWindowsPath(outputPath, 'attestation output');
  if (!sameWindowsPath(requestedOutput, exactOutput)) {
    fail(`attestation output must be the isolated current-run path ${exactOutput}`);
  }
  const installedExecutablePath = path.win32.join(installRoot, WINDOWS_MODE2_SMOKE_EXECUTABLE);
  const observationPath = path.win32.join(evidenceRoot, 'observation-ready.json');
  const ackPath = path.win32.join(evidenceRoot, 'observation-ack.json');
  const receiptPath = path.win32.join(evidenceRoot, 'runtime-receipt.json');
  const normalizedInstaller = exactWindowsPath(installerPath, 'NSIS installer');
  const normalizedStage = exactWindowsPath(stageDir, 'CEF stage');
  const exactSourceCommit = exactGitSha(sourceCommit);
  const exactVersion = exactAppVersion(appVersion);
  const exactSmokeNonce = exactNonce(nonce);

  return {
    platform: WINDOWS_MODE2_SMOKE_PLATFORM,
    sourceCommit: exactSourceCommit,
    appVersion: exactVersion,
    run,
    paths: {
      smokeRoot,
      installRoot,
      evidenceRoot,
      installerPath: normalizedInstaller,
      stageDir: normalizedStage,
      stageManifestPath: path.win32.join(normalizedStage, WINDOWS_MODE2_SMOKE_MANIFEST),
      installedExecutablePath,
      observationPath,
      ackPath,
      receiptPath,
      attestationPath: exactOutput,
    },
    nonce: exactSmokeNonce,
    timeoutMs: timeoutValue(timeoutMs),
    install: {
      program: normalizedInstaller,
      // NSIS requires /D= to be the final argument. spawn() passes it without shell quoting.
      args: ['/S', `/D=${installRoot}`],
    },
    launch: {
      program: installedExecutablePath,
      args: [],
      environment: {
        CCEM_WINDOWS_MODE2_SMOKE_ALLOW: '1',
        CCEM_WINDOWS_MODE2_SMOKE_EVIDENCE_ROOT: evidenceRoot,
        CCEM_WINDOWS_MODE2_SMOKE_OBSERVATION_PATH: observationPath,
        CCEM_WINDOWS_MODE2_SMOKE_ACK_PATH: ackPath,
        CCEM_WINDOWS_MODE2_SMOKE_RECEIPT_PATH: receiptPath,
        CCEM_WINDOWS_MODE2_SMOKE_EXPECTED_EXE: installedExecutablePath,
        CCEM_WINDOWS_MODE2_SMOKE_NONCE: exactSmokeNonce,
      },
    },
  };
}

export function validateWindowsMode2StageManifest(manifest, plan, environment = process.env) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('CEF stage manifest must be an object');
  }
  if (
    manifest.schemaVersion !== 4
    || manifest.target !== WINDOWS_MODE2_SMOKE_PLATFORM
    || manifest.profile !== 'release'
    || manifest.sourceCommit !== plan.sourceCommit
    || JSON.stringify(manifest.sourcePin) !== JSON.stringify(WINDOWS_CEF_SOURCE_PIN)
    || environment.GITHUB_SHA !== plan.sourceCommit
    || manifest.provenance?.source !== 'runner-temp-current-run'
    || manifest.provenance?.runId !== plan.run.id
    || manifest.provenance?.runAttempt !== plan.run.attempt
  ) {
    fail('CEF stage manifest is not bound to this release-profile run attempt');
  }
  if (!manifest.hashes || typeof manifest.hashes !== 'object' || Array.isArray(manifest.hashes)) {
    fail('CEF stage manifest hashes are missing');
  }
  const hashes = Object.fromEntries(Object.entries(manifest.hashes).map(([relativePath, digest]) => [
    exactRelativePath(relativePath, 'CEF stage manifest path'),
    exactSha256(digest, `CEF stage manifest ${relativePath}`),
  ]));
  const hashPaths = Object.keys(hashes).sort((left, right) => left.localeCompare(right));
  if (
    hashPaths.length === 0
    || !Array.isArray(manifest.files)
    || manifest.files.length !== hashPaths.length
    || new Set(manifest.files).size !== manifest.files.length
    || JSON.stringify([...manifest.files].sort((left, right) => left.localeCompare(right))) !== JSON.stringify(hashPaths)
  ) {
    fail('CEF stage manifest file inventory is incomplete');
  }
  for (const relativePath of manifest.files) {
    if (!(exactRelativePath(relativePath, 'CEF stage manifest file') in hashes)) {
      fail(`CEF stage manifest file has no digest: ${relativePath}`);
    }
  }
  const thumbprint = normalizeThumbprint(environment.WINDOWS_CERTIFICATE_THUMBPRINT);
  const publisher = exactPublisher(environment.CCEM_OFFICIAL_WINDOWS_PUBLISHER);
  if (
    normalizeThumbprint(manifest.signer?.thumbprint) !== thumbprint
    || manifest.signer?.publisher !== publisher
    || manifest.signer?.timestamped !== true
    || !Array.isArray(manifest.signer?.signedFiles)
    || manifest.signer.signedFiles.length === 0
  ) {
    fail('CEF stage manifest signer is not the exact current release signer');
  }
  if (new Set(manifest.signer.signedFiles).size !== manifest.signer.signedFiles.length) {
    fail('CEF stage manifest signed file inventory contains duplicates');
  }
  const signedFiles = manifest.signer.signedFiles.map((relativePath) => {
    const safe = exactRelativePath(relativePath, 'signed CEF resource');
    if (!(safe in hashes)) fail(`signed CEF resource is outside the stable inventory: ${safe}`);
    return safe;
  }).sort((left, right) => left.localeCompare(right));
  const expectedSignedFiles = hashPaths.filter((relativePath) => relativePath.toLowerCase().endsWith('.dll'));
  if (JSON.stringify(signedFiles) !== JSON.stringify(expectedSignedFiles)) {
    fail('CEF stage manifest must sign the exact stable DLL path set');
  }
  return { stableCefResources: hashes, signer: { thumbprint, publisher, signedFiles } };
}

export function createSmokeChildEnvironment(environment, smokeEnvironment) {
  const allowed = new Set([
    'APPDATA', 'COMSPEC', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'PATH', 'PATHEXT',
    'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
    'GITHUB_ACTIONS', 'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_ID', 'GITHUB_SHA',
    'RUNNER_OS', 'RUNNER_TEMP',
  ]);
  const clean = {};
  for (const [name, value] of Object.entries(environment)) {
    if (allowed.has(name.toUpperCase()) && typeof value === 'string') clean[name] = value;
  }
  return { ...clean, ...smokeEnvironment };
}

function validateStages(stages, expectedNames, label) {
  if (!Array.isArray(stages) || stages.length !== expectedNames.length) {
    fail(`${label} stages are incomplete`);
  }
  let previous = -1;
  stages.forEach((stage, index) => {
    exactKeys(stage, ['name', 'monotonicMs'], `${label} stage ${index}`);
    if (
      stage.name !== expectedNames[index]
      || !Number.isSafeInteger(stage.monotonicMs)
      || stage.monotonicMs < 0
      || stage.monotonicMs <= previous
    ) {
      fail(`${label} stage ${index} is invalid`);
    }
    previous = stage.monotonicMs;
  });
  return stages;
}

export function validateObservationCheckpoint(checkpoint, plan, launchedPid) {
  exactKeys(checkpoint, [
    'schemaVersion', 'nonce', 'sourceCommit', 'appVersion', 'runId', 'runAttempt',
    'mainPid', 'executablePath', 'sandboxEnabled', 'networkServiceSandboxFeature',
    'networkServiceSandboxRequested', 'networkServiceLpacFeature',
    'networkServiceLpacRequested', 'productionPath', 'stages',
  ], 'observation checkpoint');
  if (
    checkpoint.schemaVersion !== WINDOWS_MODE2_SMOKE_SCHEMA_VERSION
    || checkpoint.nonce !== plan.nonce
    || checkpoint.sourceCommit !== plan.sourceCommit
    || checkpoint.appVersion !== plan.appVersion
    || checkpoint.runId !== plan.run.id
    || checkpoint.runAttempt !== plan.run.attempt
    || checkpoint.sandboxEnabled !== true
    || checkpoint.networkServiceSandboxFeature !== 'NetworkServiceSandbox'
    || checkpoint.networkServiceSandboxRequested !== true
    || checkpoint.networkServiceLpacFeature !== 'WinSboxNetworkServiceSandboxIsLPAC'
    || checkpoint.networkServiceLpacRequested !== true
    || !Number.isSafeInteger(checkpoint.mainPid)
    || checkpoint.mainPid <= 0
    || checkpoint.mainPid !== launchedPid
  ) {
    fail('observation checkpoint identity is invalid');
  }
  exactWindowsPath(checkpoint.executablePath, 'checkpoint executable path');
  if (!sameWindowsPath(checkpoint.executablePath, plan.paths.installedExecutablePath)) {
    fail('observation checkpoint executable path mismatch');
  }
  validateProductionCheckpoint(checkpoint.productionPath, plan);
  if (checkpoint.productionPath.nativeWindow.ownerPid !== checkpoint.mainPid) {
    fail('checkpoint native HWND is not owned by the launched browser process');
  }
  validateStages(
    checkpoint.stages,
    [
      'direct_ready', 'direct_cdp', 'direct_closed', 'production_acquired_hidden_ready',
      'production_shown', 'production_hidden', 'production_reshown',
    ],
    'observation checkpoint',
  );
  return checkpoint;
}

function validateProductionCheckpoint(productionPath, plan) {
  exactKeys(productionPath, [
    'verified', 'manager', 'dataRoot', 'workspaceRoot', 'ownerRecordRoot',
    'profileStateRoot', 'cefCacheRoot', 'profileId', 'nativeWindow',
  ], 'production path checkpoint');
  if (productionPath.verified !== true || productionPath.manager !== 'LoginBrowserSurfaceManager') {
    fail('checkpoint did not enter the production LoginBrowserSurfaceManager path');
  }
  const expectedRoots = {
    dataRoot: path.win32.join(plan.paths.smokeRoot, 'data'),
    workspaceRoot: path.win32.join(plan.paths.smokeRoot, 'workspace'),
    ownerRecordRoot: path.win32.join(plan.paths.smokeRoot, 'data', 'login', 'embedded-owners'),
    profileStateRoot: path.win32.join(plan.paths.smokeRoot, 'data', 'login', 'profile-state'),
    cefCacheRoot: path.win32.join(plan.paths.smokeRoot, 'data', 'login', 'cef'),
  };
  for (const [field, wanted] of Object.entries(expectedRoots)) {
    exactWindowsPath(productionPath[field], `checkpoint production ${field}`);
    if (!sameWindowsPath(productionPath[field], wanted)) {
      fail(`checkpoint production ${field} escaped the current run`);
    }
  }
  if (!/^profile-[a-f0-9]{32}$/u.test(productionPath.profileId ?? '')) {
    fail('checkpoint production profile id is invalid');
  }
  validateWindowsNativeWindowObservation(productionPath.nativeWindow);
  return productionPath;
}

export function validateLiveRuntimeObservation(observation, checkpoint, executableSha256, plan) {
  exactKeys(observation, ['window', 'processClosure', 'processes'], 'live native observation');
  validateWindowsNativeWindowObservation(
    observation.window,
    checkpoint.productionPath.nativeWindow,
  );
  validateWindowsProcessSandboxEvidence(observation.processClosure, observation.processes, checkpoint, {
    installedExecutablePath: plan.paths.installedExecutablePath,
    installedExecutableSha256: executableSha256,
  });
  return observation;
}

export function createObservationAck(plan, checkpoint) {
  return {
    schemaVersion: WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
    nonce: plan.nonce,
    runId: plan.run.id,
    runAttempt: plan.run.attempt,
    mainPid: checkpoint.mainPid,
    observed: true,
  };
}

export function validateFinalReceipt(receipt, checkpoint, plan) {
  validateWindowsNativeWindowObservation(
    receipt?.productionPath?.nativeWindow,
    checkpoint.productionPath.nativeWindow,
  );
  if (
    receipt?.nonce !== plan.nonce
    || receipt?.sourceCommit !== plan.sourceCommit
    || receipt?.appVersion !== plan.appVersion
    || receipt?.mainPid !== checkpoint.mainPid
    || receipt?.networkServiceSandboxFeature !== checkpoint.networkServiceSandboxFeature
    || receipt?.networkServiceSandboxRequested !== checkpoint.networkServiceSandboxRequested
    || receipt?.networkServiceLpacFeature !== checkpoint.networkServiceLpacFeature
    || receipt?.networkServiceLpacRequested !== checkpoint.networkServiceLpacRequested
    || !sameWindowsPath(receipt?.executablePath ?? '', plan.paths.installedExecutablePath)
    || JSON.stringify(receipt?.stages?.slice(0, checkpoint.stages.length)) !== JSON.stringify(checkpoint.stages)
    || receipt?.productionPath?.profileId !== checkpoint.productionPath.profileId
    || receipt?.productionPath?.manager !== checkpoint.productionPath.manager
    || receipt?.productionPath?.verified !== true
  ) {
    fail('final receipt does not extend the observed current-run checkpoint');
  }
  return receipt;
}

export function assembleWindowsMode2ProductionSmokeAttestation({
  plan,
  upgradeAclSeed,
  preflight,
  evidenceAcl,
  receipt,
  window,
  processClosure,
  processes,
  cleanup,
}) {
  const fingerprint = createWindowsRuntimeInventoryFingerprint({
    installedExecutableSha256: preflight.installedExecutableSha256,
    stableCefResources: preflight.stableCefResources,
  });
  const expected = {
    sourceCommit: plan.sourceCommit,
    appVersion: plan.appVersion,
    runId: plan.run.id,
    runAttempt: plan.run.attempt,
    repository: plan.run.repository,
    workflowRef: plan.run.workflowRef,
    producerWorkflowRef: plan.run.producerWorkflowRef,
    job: plan.run.job,
    installedRoot: plan.paths.installRoot,
    installedExecutablePath: plan.paths.installedExecutablePath,
    installedExecutableSha256: preflight.installedExecutableSha256,
    installerSha256: preflight.installerSha256,
    runtimeInventorySha256: fingerprint.sha256,
    verifiedPathCount: fingerprint.verifiedPathCount,
    runtimeRelativePaths: fingerprint.relativePaths,
    installedTreeInventorySha256: preflight.installedTree.inventorySha256,
    installedTreePathSetSha256: preflight.installedTree.pathSetSha256,
    installedTreePathCount: preflight.installedTree.pathCount,
    smokeRoot: plan.paths.smokeRoot,
  };
  const attestation = {
    schemaVersion: WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
    platform: WINDOWS_MODE2_SMOKE_PLATFORM,
    sourceCommit: plan.sourceCommit,
    appVersion: plan.appVersion,
    run: { ...plan.run, smokeRoot: plan.paths.smokeRoot },
    installed: {
      root: plan.paths.installRoot,
      executablePath: plan.paths.installedExecutablePath,
      executableSha256: preflight.installedExecutableSha256,
      installerSha256: preflight.installerSha256,
      runtimeInventorySha256: fingerprint.sha256,
      installedTree: preflight.installedTree,
      installedTreeSafety: preflight.installedTreeSafety,
    },
    runtime: {
      receipt,
      receiptSha256: hashWindowsMode2SmokeJson(receipt),
      window,
      processClosure,
      processes,
    },
    upgradeAclSeed,
    evidenceAcl,
    lpacAcl: preflight.lpacAcl,
    cleanup,
  };
  const summary = validateWindowsMode2ProductionSmokeAttestation(attestation, expected);
  return { attestation, expected, summary };
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output.trim());
  } catch (error) {
    fail(`${label} did not return JSON: ${error.message}`);
  }
}

async function runCommand(command, { environment, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.program, command.args, {
      shell: false,
      windowsHide: true,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (current, bytes) => `${current}${bytes}`.slice(-MAX_JSON_BYTES);
    child.stdout.on('data', (bytes) => { stdout = append(stdout, bytes); });
    child.stderr.on('data', (bytes) => { stderr = append(stderr, bytes); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`command timed out: ${command.program}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`command failed (${code ?? signal}): ${command.program}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

async function launchTracked(plan, environment) {
  return new Promise((resolve, reject) => {
    const notBeforeCreationTime100ns = (
      (BigInt(Date.now()) + 11_644_473_600_000n) * 10_000n
    ).toString();
    const child = spawn(plan.launch.program, plan.launch.args, {
      shell: false,
      windowsHide: false,
      env: createSmokeChildEnvironment(environment, plan.launch.environment),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawned = false;
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (bytes) => { stderr = `${stderr}${bytes}`.slice(-MAX_JSON_BYTES); });
    const exit = new Promise((exitResolve, exitReject) => {
      child.once('exit', (code, signal) => exitResolve({ code, signal }));
      child.once('error', (error) => exitReject(error));
    });
    child.once('spawn', () => {
      spawned = true;
      resolve({ pid: child.pid, notBeforeCreationTime100ns, exit, stderr: () => stderr });
    });
    child.once('error', (error) => {
      if (!spawned) reject(error);
    });
  });
}

function waitWithTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readAtomicJsonWhenReady(candidate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fsp.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JSON_BYTES) {
        fail(`smoke evidence is not a bounded regular file: ${candidate}`);
      }
      return JSON.parse(await fsp.readFile(candidate, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  fail(`smoke evidence timed out: ${candidate}`);
}

async function writeJsonAtomically(candidate, value) {
  try {
    await fsp.lstat(candidate);
    fail(`refusing to replace existing smoke evidence: ${candidate}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${candidate}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const file = await fsp.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await fsp.link(temporary, candidate);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  return {
    path: candidate,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function validateOwnedProcessCleanupObservation(observation, label) {
  exactKeys(observation, ['remainingOwnedPids', 'remainingClosurePids'], label);
  for (const field of ['remainingOwnedPids', 'remainingClosurePids']) {
    const values = observation[field];
    if (!Array.isArray(values)) fail(`${label} ${field} must be an array`);
    const canonical = [...new Set(values)].sort((left, right) => left - right);
    if (
      values.some((value) => !Number.isSafeInteger(value) || value <= 0)
      || JSON.stringify(values) !== JSON.stringify(canonical)
    ) fail(`${label} ${field} must be sorted, unique, positive PIDs`);
  }
  return observation;
}

async function prepareSmokeRoots(plan) {
  try {
    await fsp.lstat(plan.paths.smokeRoot);
    fail(`current-run smoke root already exists: ${plan.paths.smokeRoot}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fsp.mkdir(plan.paths.evidenceRoot, { recursive: true });
}

async function requireRegularFile(candidate, label) {
  const stat = await fsp.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
}

function defaultExecutionDependencies() {
  return {
    prepareRoots: prepareSmokeRoots,
    protectEvidenceRoot: async (plan) => parseJsonOutput(await runCommand(
      createWindowsEvidenceRootAclCommand({ plan }),
      { timeoutMs: Math.min(plan.timeoutMs, 30_000) },
    ), 'Windows evidence-root ACL'),
    seedUpgradeAcl: async (plan) => parseJsonOutput(await runCommand(
      createWindowsUpgradeAclSeedCommand({ plan }),
      { timeoutMs: Math.min(plan.timeoutMs, 30_000) },
    ), 'Windows upgrade ACL seed'),
    install: (plan) => runCommand(plan.install, { timeoutMs: plan.timeoutMs }),
    inspectPreflight: async (plan, identity) => parseJsonOutput(await runCommand(
      createWindowsPreflightInspectionCommand({
        plan,
        stableCefResources: identity.stableCefResources,
        signer: identity.signer,
      }),
      { timeoutMs: plan.timeoutMs },
    ), 'Windows preflight inspection'),
    launch: launchTracked,
    waitForJson: readAtomicJsonWhenReady,
    observeProcesses: async (plan, checkpoint, executableSha256) => {
      const deadline = Date.now() + Math.min(plan.timeoutMs, 20_000);
      let incomplete;
      do {
        const observation = parseJsonOutput(await runCommand(
          createWindowsProcessObservationCommand({ plan, checkpoint }),
          { timeoutMs: Math.min(plan.timeoutMs, 10_000) },
        ), 'Windows live native observation');
        try {
          return validateLiveRuntimeObservation(
            observation,
            checkpoint,
            executableSha256,
            plan,
          );
        } catch (error) {
          if (!/(?:include|missing) (?:browser|CEF children|renderer|gpu-process|utility)|browser root is absent|full descendant closure changed|OpenProcess\(PROCESS_QUERY_LIMITED_INFORMATION\)|process identity changed during native evidence capture|CIM process identity changed during native evidence capture/u.test(error.message)) throw error;
          incomplete = error;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } while (Date.now() < deadline);
      throw incomplete;
    },
    writeJson: writeJsonAtomically,
    waitForExit: (launched, timeoutMs) => waitWithTimeout(launched.exit, timeoutMs, 'installed smoke app exit'),
    inspectCleanup: async (plan, processClosure) => parseJsonOutput(await runCommand(
      createWindowsOwnedProcessCommand(plan, 'inspect', processClosure),
      { timeoutMs: plan.timeoutMs },
    ), 'Windows owned-process cleanup'),
    terminate: async (plan, launched, processClosure = []) => parseJsonOutput(await runCommand(
      createWindowsOwnedProcessCommand(plan, 'terminate', processClosure, launched), {
        timeoutMs: Math.min(plan.timeoutMs, 30_000),
      },
    ), 'Windows owned-process termination'),
    writeAttestation: writeJsonAtomically,
  };
}

export async function executeWindowsMode2ProductionSmoke(
  { plan, manifestIdentity, environment = process.env },
  dependencies = {},
) {
  const runtime = { ...defaultExecutionDependencies(), ...dependencies };
  let launched;
  let rootsPrepared = false;
  let observedProcessClosure = [];
  try {
    await runtime.prepareRoots(plan);
    rootsPrepared = true;
    const evidenceAcl = validateWindowsEvidenceRootAclObservation(
      await runtime.protectEvidenceRoot(plan),
      plan,
    );
    const upgradeAclSeed = validateWindowsUpgradeAclSeedObservation(
      await runtime.seedUpgradeAcl(plan),
      plan,
    );
    await runtime.install(plan);
    const preflight = validatePreflightObservation(
      await runtime.inspectPreflight(plan, manifestIdentity),
      plan,
      manifestIdentity,
    );
    launched = await runtime.launch(plan, environment);
    const checkpoint = validateObservationCheckpoint(
      await runtime.waitForJson(plan.paths.observationPath, plan.timeoutMs),
      plan,
      launched.pid,
    );
    const observation = validateLiveRuntimeObservation(
      await runtime.observeProcesses(plan, checkpoint, preflight.installedExecutableSha256),
      checkpoint,
      preflight.installedExecutableSha256,
      plan,
    );
    observedProcessClosure = observation.processClosure;
    await runtime.writeJson(plan.paths.ackPath, createObservationAck(plan, checkpoint));
    const receipt = validateFinalReceipt(
      await runtime.waitForJson(plan.paths.receiptPath, plan.timeoutMs),
      checkpoint,
      plan,
    );
    const exit = await runtime.waitForExit(launched, plan.timeoutMs);
    const owned = validateOwnedProcessCleanupObservation(
      await runtime.inspectCleanup(plan, observedProcessClosure),
      'owned-process cleanup',
    );
    if (owned.remainingOwnedPids.length !== 0 || owned.remainingClosurePids.length !== 0) {
      fail('observed CEF or Wry host processes remained after the installed smoke');
    }
    const cleanup = {
      mainExitCode: exit.code,
      observedClosurePids: observedProcessClosure.map((entry) => entry.pid),
      remainingOwnedPids: owned.remainingOwnedPids,
      remainingClosurePids: owned.remainingClosurePids,
    };
    const assembled = assembleWindowsMode2ProductionSmokeAttestation({
      plan,
      upgradeAclSeed,
      preflight,
      evidenceAcl,
      receipt,
      window: observation.window,
      processClosure: observation.processClosure,
      processes: observation.processes,
      cleanup,
    });
    const writtenAttestation = await runtime.writeAttestation(
      plan.paths.attestationPath,
      assembled.attestation,
    );
    const attestationSha256 = exactSha256(
      writtenAttestation?.sha256,
      'protected Windows smoke attestation bytes',
    );
    const summary = validateWindowsMode2SmokeSummary({
      ...assembled.summary,
      attestationSha256,
    }, assembled.expected);
    return {
      status: 'attested',
      path: plan.paths.attestationPath,
      ...assembled,
      summary,
    };
  } catch (error) {
    const stderr = launched?.stderr?.().trim();
    if (stderr) error.message = `${error.message}; installed smoke stderr: ${stderr}`;
    if (rootsPrepared) {
      try {
        const terminated = validateOwnedProcessCleanupObservation(
          await runtime.terminate(plan, launched, observedProcessClosure),
          'owned-process termination',
        );
        if (
          terminated.remainingOwnedPids.length !== 0
          || terminated.remainingClosurePids.length !== 0
        ) {
          throw new Error(
            `termination left owned PIDs [${terminated.remainingOwnedPids.join(', ')}] `
            + `or closure PIDs [${terminated.remainingClosurePids.join(', ')}]`,
          );
        }
      } catch (cleanupError) {
        error.message = `${error.message}; owned-process termination also failed: ${cleanupError.message}`;
      }
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = { dryRun: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--help') options.help = true;
    else if (['--installer', '--stage', '--version', '--source-commit', '--output', '--timeout-ms'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      index += 1;
      if (argument === '--installer') options.installerPath = value;
      if (argument === '--stage') options.stageDir = value;
      if (argument === '--version') options.appVersion = value;
      if (argument === '--source-commit') options.sourceCommit = value;
      if (argument === '--output') options.outputPath = value;
      if (argument === '--timeout-ms') options.timeoutMs = Number(value);
    } else fail(`unknown argument: ${argument}`);
  }
  return options;
}

export async function run(
  argv = process.argv.slice(2),
  { environment = process.env, platform = process.platform, dependencies = {}, writeOutput } = {},
) {
  const options = parseArgs(argv);
  if (options.help) {
    const usage = 'Usage: node scripts/run-windows-mode2-production-smoke.mjs --installer <nsis> --stage <cef-stage> --version <v> --source-commit <sha> --output <attestation> [--timeout-ms <ms>] [--dry-run]\n';
    (writeOutput ?? process.stdout.write.bind(process.stdout))(usage);
    return { status: 'help' };
  }
  for (const [name, value] of [
    ['--installer', options.installerPath], ['--stage', options.stageDir],
    ['--version', options.appVersion], ['--source-commit', options.sourceCommit],
  ]) if (!value) fail(`${name} is required`);
  const plan = createWindowsMode2SmokePlan({ ...options, environment });
  if (options.dryRun) {
    (writeOutput ?? process.stdout.write.bind(process.stdout))(`${JSON.stringify(plan, null, 2)}\n`);
    return { status: 'dry-run', plan };
  }
  assertWindowsMode2SmokeAuthorization(environment, platform);
  await requireRegularFile(plan.paths.installerPath, 'NSIS installer');
  await requireRegularFile(plan.paths.stageManifestPath, 'CEF stage manifest');
  const manifest = parseJsonOutput(
    await fsp.readFile(plan.paths.stageManifestPath, 'utf8'),
    'CEF stage manifest',
  );
  const manifestIdentity = validateWindowsMode2StageManifest(manifest, plan, environment);
  const result = await executeWindowsMode2ProductionSmoke({
    plan, manifestIdentity, environment,
  }, dependencies);
  (writeOutput ?? process.stdout.write.bind(process.stdout))(`${JSON.stringify(result.summary)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
