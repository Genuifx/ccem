import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  createWindowsInstalledTreeInventory,
  validateWindowsInstalledTreeInventory,
} from './windows-mode2-installed-tree-contract.mjs';

export {
  createWindowsInstalledTreeInventory,
  validateWindowsInstalledTreeInventory,
};

export const WINDOWS_MODE2_SMOKE_SCHEMA_VERSION = 6;
export const WINDOWS_MODE2_SMOKE_PLATFORM = 'x86_64-pc-windows-msvc';
export const WINDOWS_MODE2_CHROMIUM_VERSION = '150.0.7871.101';
export const WINDOWS_MODE2_SANDBOX_PROFILE = 'chromium-150-win-token-v1';
export const WINDOWS_LPAC_SID = 'S-1-15-2-2';
const WINDOWS_SYSTEM_SID = 'S-1-5-18';
export const WINDOWS_MODE2_REQUIRED_STAGES = Object.freeze([
  'direct_ready',
  'direct_cdp',
  'direct_closed',
  'production_acquired_hidden_ready',
  'production_shown',
  'production_hidden',
  'production_reshown',
  'production_handoff',
  'production_semantic_read_write',
  'production_occluded',
  'production_stale_write_denied',
  'production_restored',
  'production_rehandoff',
  'production_post_pause_verified',
  'production_paused',
  'production_takeover',
  'production_released',
  'production_reopened_ready',
  'production_reopened_shown',
  'production_reclosed',
  'production_cleanup_verified',
]);
export const WINDOWS_MODE2_REQUIRED_PROCESS_TYPES = Object.freeze([
  'renderer',
  'gpu-process',
  'utility',
]);
export const WINDOWS_MODE2_SMOKE_DIRECTORY = 'ccem-mode2-production-smoke';
export const WINDOWS_MODE2_MAIN_EXECUTABLE = 'ccem-desktop.exe';

function fail(message) {
  throw new Error(`[windows-mode2-smoke] ${message}`);
}

function exactSha256(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? '')) fail(`${label} must be an exact SHA-256`);
  return value;
}

function exactGitSha(value, label) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? '')) fail(`${label} must be an exact Git SHA`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

function exactRunNumber(value, label) {
  if (!/^\d+$/u.test(value ?? '')) fail(`${label} must be a GitHub run number`);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('smoke evidence contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  fail('smoke evidence contains a non-JSON value');
}

export function hashWindowsMode2SmokeJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function expectedWindowsMode2SmokeRoot(environment) {
  const runnerTemp = exactWindowsPath(environment.RUNNER_TEMP, 'RUNNER_TEMP');
  const runId = exactRunNumber(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID');
  const runAttempt = exactRunNumber(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT');
  return path.win32.join(
    runnerTemp,
    WINDOWS_MODE2_SMOKE_DIRECTORY,
    `${runId}-${runAttempt}`,
  );
}

export function expectedWindowsMode2InstallRoot(environment) {
  return path.win32.join(expectedWindowsMode2SmokeRoot(environment), 'app');
}

export function expectedWindowsMode2EvidenceRoot(environment) {
  return path.win32.join(expectedWindowsMode2SmokeRoot(environment), 'evidence');
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

export function createWindowsRuntimeInventoryFingerprint({
  installedExecutableSha256,
  stableCefResources,
}) {
  exactSha256(installedExecutableSha256, 'runtime inventory main executable');
  if (!stableCefResources || typeof stableCefResources !== 'object' || Array.isArray(stableCefResources)) {
    fail('stable CEF resources must be an object');
  }
  const files = Object.entries(stableCefResources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, digest]) => {
      if (
        typeof relativePath !== 'string'
        || relativePath.length === 0
        || relativePath.includes('\\')
        || relativePath.startsWith('/')
        || relativePath.split('/').some((part) => !part || part === '.' || part === '..')
      ) {
        fail(`runtime inventory path is invalid: ${relativePath}`);
      }
      return [relativePath, exactSha256(digest, `runtime inventory ${relativePath}`)];
    });
  const bytes = JSON.stringify({
    schemaVersion: WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
    installedExecutableSha256,
    files,
  });
  const relativePaths = [
    WINDOWS_MODE2_MAIN_EXECUTABLE,
    ...files.map(([relativePath]) => relativePath),
  ].sort((left, right) => left.localeCompare(right));
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    verifiedPathCount: relativePaths.length,
    relativePaths,
  };
}

function validateRuntimeRelativePaths(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const normalized = value.map((relativePath) => {
    if (
      typeof relativePath !== 'string'
      || relativePath.length === 0
      || relativePath.includes('\\')
      || relativePath.startsWith('/')
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      fail(`${label} contains an invalid relative path`);
    }
    return relativePath;
  });
  const sorted = [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(normalized) !== JSON.stringify(sorted)) {
    fail(`${label} must be sorted and duplicate-free`);
  }
  if (!normalized.includes(WINDOWS_MODE2_MAIN_EXECUTABLE)) {
    fail(`${label} must include the installed main executable`);
  }
  return normalized;
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

function opaqueHwnd(value, label) {
  if (!/^0x[0-9a-f]+$/u.test(value ?? '') || value === '0x0') {
    fail(`${label} must be a non-null opaque HWND`);
  }
  return value;
}

function exactSid(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!/^S-1-(?:\d+-)+\d+$/u.test(value ?? '')) fail(`${label} must be a Windows SID`);
  return value;
}

function exactSidList(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const sids = value.map((sid) => exactSid(sid, label));
  const canonical = [...new Set(sids)].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(sids) !== JSON.stringify(canonical)) {
    fail(`${label} must be sorted and duplicate-free`);
  }
  return sids;
}

export function validateWindowsNativeWindowObservation(window, expected = undefined) {
  exactKeys(window, [
    'hwnd', 'parentHwnd', 'ownerPid', 'x', 'y', 'width', 'height',
    'parentClientWidth', 'parentClientHeight', 'visible', 'dpi',
  ], 'native HWND observation');
  opaqueHwnd(window.hwnd, 'CEF child HWND');
  opaqueHwnd(window.parentHwnd, 'CEF parent HWND');
  if (window.hwnd === window.parentHwnd) fail('CEF child HWND aliases its parent');
  positiveInteger(window.ownerPid, 'CEF child HWND owner PID');
  for (const field of ['x', 'y', 'width', 'height', 'parentClientWidth', 'parentClientHeight']) {
    if (!Number.isSafeInteger(window[field])) fail(`native HWND ${field} must be an integer`);
  }
  if (
    window.x < 0 || window.y < 0 || window.width <= 0 || window.height <= 0
    || window.parentClientWidth <= 0 || window.parentClientHeight <= 0
    || window.x + window.width > window.parentClientWidth
    || window.y + window.height > window.parentClientHeight
  ) fail('CEF child HWND escaped the parent client rectangle');
  if (window.visible !== true) fail('CEF child HWND is not actually visible');
  if (!Number.isSafeInteger(window.dpi) || window.dpi < 96 || window.dpi > 960) {
    fail('CEF child HWND effective DPI is invalid');
  }
  const scale = window.dpi / 96;
  const wanted = {
    x: Math.floor(120 * scale),
    y: Math.floor(100 * scale),
    width: Math.ceil((120 + 720) * scale) - Math.floor(120 * scale),
    height: Math.ceil((100 + 480) * scale) - Math.floor(100 * scale),
  };
  for (const field of ['x', 'y', 'width', 'height']) {
    if (window[field] !== wanted[field]) {
      fail(`CEF child HWND ${field} does not match the DPI-scaled BrowserPanel viewport`);
    }
  }
  if (expected !== undefined) {
    validateWindowsNativeWindowObservation(expected);
    for (const field of Object.keys(window)) {
      if (window[field] !== expected[field]) {
        fail('external HWND observation does not match the in-process Win32 checkpoint');
      }
    }
  }
  return window;
}

function validateTokenEvidence(token, type, utilitySubtype) {
  exactKeys(token, [
    'isAppContainer', 'isLessPrivilegedAppContainer', 'appContainerSid',
    'integritySid', 'integrityRid',
    'isRestricted', 'restrictedSidCount', 'restrictedSids', 'capabilitySidCount',
    'capabilitySids', 'groupSidCount', 'groupSids',
  ], `${type} token evidence`);
  if (
    typeof token.isAppContainer !== 'boolean'
    || typeof token.isLessPrivilegedAppContainer !== 'boolean'
    || typeof token.isRestricted !== 'boolean'
  ) {
    fail(`${type} token booleans are invalid`);
  }
  exactSid(token.integritySid, `${type} integrity SID`);
  if (!Number.isSafeInteger(token.integrityRid) || token.integrityRid < 0) {
    fail(`${type} integrity RID is invalid`);
  }
  const integrityRid = Number(token.integritySid.split('-').at(-1));
  if (integrityRid !== token.integrityRid) fail(`${type} integrity SID and RID disagree`);
  const restrictedSids = exactSidList(token.restrictedSids, `${type} restricted SIDs`);
  const capabilitySids = exactSidList(token.capabilitySids, `${type} capability SIDs`);
  const groupSids = exactSidList(token.groupSids, `${type} group SIDs`);
  for (const [field, values] of [
    ['restrictedSidCount', restrictedSids],
    ['capabilitySidCount', capabilitySids],
    ['groupSidCount', groupSids],
  ]) {
    if (!Number.isSafeInteger(token[field]) || token[field] !== values.length) {
      fail(`${type} ${field} does not bind its SID set`);
    }
  }
  if (token.isAppContainer) {
    exactSid(token.appContainerSid, `${type} AppContainer SID`);
    if (!token.appContainerSid.startsWith('S-1-15-2-')) {
      fail(`${type} AppContainer SID is outside the AppContainer authority`);
    }
  } else if (exactSid(token.appContainerSid, `${type} AppContainer SID`, { nullable: true }) !== null) {
    fail(`${type} non-AppContainer token unexpectedly carries an AppContainer SID`);
  }
  if (token.isLessPrivilegedAppContainer && !token.isAppContainer) {
    fail(`${type} token claims LPAC without being an AppContainer`);
  }

  if (type === 'browser') {
    if (token.isAppContainer || token.integrityRid < 8192) {
      fail('browser process token is not the expected unsandboxed broker token');
    }
  } else if (type === 'renderer') {
    if (token.isAppContainer || !token.isRestricted || token.integrityRid !== 0) {
      fail('renderer token is not the Chromium 150 restricted Untrusted token');
    }
  } else if (type === 'gpu-process') {
    if (token.isAppContainer || !token.isRestricted || token.integrityRid !== 4096) {
      fail('GPU token is not the Chromium 150 restricted Low token');
    }
  } else if (type === 'utility') {
    if (!utilitySubtype) fail('utility token evidence is missing --utility-sub-type');
    if (utilitySubtype === 'network.mojom.NetworkService') {
      if (
        !token.isAppContainer || !token.isLessPrivilegedAppContainer
        || token.integrityRid > 4096
        || token.appContainerSid === null
      ) {
        fail('NetworkService is not running inside its explicitly enabled AppContainer sandbox');
      }
      const tokenAuthorities = new Set([
        ...token.restrictedSids,
        ...token.capabilitySids,
        ...token.groupSids,
      ]);
      if (!tokenAuthorities.has(WINDOWS_LPAC_SID)) {
        fail('NetworkService token is not the LPAC principal granted installed-tree read-execute');
      }
    } else if (!token.isRestricted || token.integrityRid > 4096) {
      fail(`utility ${utilitySubtype} does not have a restricted Low-or-lower token`);
    }
  }
  return token;
}

function validateMitigationEvidence(mitigations, type) {
  exactKeys(mitigations, [
    'depEnabled', 'bottomUpAslr', 'highEntropyAslr', 'dynamicCodeProhibited',
    'strictHandleChecks', 'win32kSystemCallsDisabled', 'extensionPointsDisabled',
    'controlFlowGuardEnabled',
  ], `${type} mitigation evidence`);
  for (const value of Object.values(mitigations)) {
    if (typeof value !== 'boolean') fail(`${type} mitigation evidence must be boolean`);
  }
  if (!mitigations.depEnabled || !mitigations.bottomUpAslr) {
    fail(`${type} process is missing baseline DEP or bottom-up ASLR`);
  }
  if (type !== 'browser' && !mitigations.extensionPointsDisabled) {
    fail(`${type} sandbox did not disable extension points`);
  }
  if (type === 'renderer' && !mitigations.win32kSystemCallsDisabled) {
    fail('renderer sandbox did not apply win32k lockdown');
  }
  return mitigations;
}

function validateRuntimeReceipt(receipt, expected) {
  exactKeys(receipt, [
    'schemaVersion', 'nonce', 'sourceCommit', 'appVersion', 'mainPid', 'executablePath',
    'sandboxEnabled', 'networkServiceSandboxFeature',
    'networkServiceSandboxRequested', 'networkServiceLpacFeature',
    'networkServiceLpacRequested', 'productionPath', 'stages',
  ], 'runtime receipt');
  if (receipt.schemaVersion !== WINDOWS_MODE2_SMOKE_SCHEMA_VERSION) {
    fail('runtime receipt schema version mismatch');
  }
  if (!/^[a-f0-9]{64}$/u.test(receipt.nonce ?? '')) fail('runtime receipt nonce is invalid');
  if (receipt.sourceCommit !== expected.sourceCommit) fail('runtime receipt source commit mismatch');
  if (receipt.appVersion !== expected.appVersion) fail('runtime receipt app version mismatch');
  positiveInteger(receipt.mainPid, 'runtime receipt main PID');
  exactWindowsPath(receipt.executablePath, 'runtime receipt executable path');
  if (!sameWindowsPath(receipt.executablePath, expected.installedExecutablePath)) {
    fail('runtime receipt executable path mismatch');
  }
  if (receipt.sandboxEnabled !== true) fail('runtime receipt did not attest an enabled sandbox');
  if (
    receipt.networkServiceSandboxFeature !== 'NetworkServiceSandbox'
    || receipt.networkServiceSandboxRequested !== true
    || receipt.networkServiceLpacFeature !== 'WinSboxNetworkServiceSandboxIsLPAC'
    || receipt.networkServiceLpacRequested !== true
  ) fail('runtime receipt did not bind the internal CEF NetworkServiceSandbox request');
  validateProductionPath(receipt.productionPath, expected.smokeRoot);
  if (receipt.productionPath.nativeWindow.ownerPid !== receipt.mainPid) {
    fail('runtime receipt native HWND is not owned by the browser process');
  }
  if (!Array.isArray(receipt.stages) || receipt.stages.length !== WINDOWS_MODE2_REQUIRED_STAGES.length) {
    fail('runtime receipt stages are incomplete');
  }
  let previous = -1;
  receipt.stages.forEach((stage, index) => {
    exactKeys(stage, ['name', 'monotonicMs'], `runtime stage ${index}`);
    if (stage.name !== WINDOWS_MODE2_REQUIRED_STAGES[index]) {
      fail(`runtime stage ${index} must be ${WINDOWS_MODE2_REQUIRED_STAGES[index]}`);
    }
    if (!Number.isSafeInteger(stage.monotonicMs) || stage.monotonicMs < 0 || stage.monotonicMs <= previous) {
      fail(`runtime stage ${stage.name} timestamp is not strictly increasing`);
    }
    previous = stage.monotonicMs;
  });
  return receipt;
}

function validateProductionPath(productionPath, smokeRoot) {
  exactKeys(productionPath, [
    'verified', 'manager', 'dataRoot', 'workspaceRoot', 'ownerRecordRoot',
    'profileStateRoot', 'cefCacheRoot', 'profileId', 'nativeWindow',
    'semantic', 'reopenedProfileId', 'cleanup',
  ], 'production path receipt');
  if (productionPath.verified !== true || productionPath.manager !== 'LoginBrowserSurfaceManager') {
    fail('runtime receipt did not exercise the production LoginBrowserSurfaceManager path');
  }
  const expectedRoots = {
    dataRoot: path.win32.join(smokeRoot, 'data'),
    workspaceRoot: path.win32.join(smokeRoot, 'workspace'),
    ownerRecordRoot: path.win32.join(smokeRoot, 'data', 'login', 'embedded-owners'),
    profileStateRoot: path.win32.join(smokeRoot, 'data', 'login', 'profile-state'),
    cefCacheRoot: path.win32.join(smokeRoot, 'data', 'login', 'cef'),
  };
  for (const [field, wanted] of Object.entries(expectedRoots)) {
    exactWindowsPath(productionPath[field], `production path ${field}`);
    if (!sameWindowsPath(productionPath[field], wanted)) {
      fail(`production path ${field} escaped the isolated current-run root`);
    }
  }
  if (
    !/^profile-[a-f0-9]{32}$/u.test(productionPath.profileId ?? '')
    || productionPath.reopenedProfileId !== productionPath.profileId
  ) {
    fail('production path did not reopen the exact persisted profile');
  }
  validateWindowsNativeWindowObservation(productionPath.nativeWindow);
  exactKeys(productionPath.semantic, [
    'readViaCapability', 'writeViaCapability', 'writeObserved',
    'postPauseWriteDenied', 'postPauseValueUnchanged',
  ], 'production semantic proof');
  if (Object.values(productionPath.semantic).some((value) => value !== true)) {
    fail('production path did not prove capability read/write and post-pause revocation');
  }
  exactKeys(productionPath.cleanup, [
    'activeSurfaceCount', 'activeSessionCount', 'ownerRecordCount',
    'persistedProfileCount', 'profileLockAvailable',
  ], 'production cleanup proof');
  if (
    productionPath.cleanup.activeSurfaceCount !== 0
    || productionPath.cleanup.activeSessionCount !== 0
    || productionPath.cleanup.ownerRecordCount !== 0
    || productionPath.cleanup.persistedProfileCount !== 1
    || productionPath.cleanup.profileLockAvailable !== true
  ) {
    fail('production path did not prove profile, owner, and session cleanup');
  }
}

function validateWindowsProcessClosure(processClosure, processes, receipt, expected) {
  if (!Array.isArray(processClosure) || processClosure.length === 0) {
    fail('runtime process closure must include the browser root');
  }
  const closureByPid = new Map();
  let previousPid = 0;
  for (const entry of processClosure) {
    exactKeys(entry, [
      'pid', 'nativePid', 'parentPid', 'creationTime100ns', 'nativeImagePath',
      'runtimeKind', 'signerThumbprint', 'signerSubject',
    ], 'runtime process closure entry');
    positiveInteger(entry.pid, 'process closure PID');
    if (entry.pid <= previousPid) fail('runtime process closure must be PID-sorted');
    previousPid = entry.pid;
    if (entry.nativePid !== entry.pid) fail(`process closure ${entry.pid} native PID mismatch`);
    if (!Number.isSafeInteger(entry.parentPid) || entry.parentPid < 0) {
      fail(`process closure ${entry.pid} parent PID is invalid`);
    }
    if (!/^[1-9]\d{10,19}$/u.test(entry.creationTime100ns ?? '')) {
      fail(`process closure ${entry.pid} creation time is invalid`);
    }
    exactWindowsPath(entry.nativeImagePath, `process closure ${entry.pid} native image`);
    const matchesInstalled = sameWindowsPath(
      entry.nativeImagePath,
      expected.installedExecutablePath,
    );
    if (entry.runtimeKind === 'cef') {
      if (entry.signerThumbprint !== null || entry.signerSubject !== null || !matchesInstalled) {
        fail(`process closure ${entry.pid} CEF executable classification is false`);
      }
    } else if (entry.runtimeKind === 'wry-webview2') {
      if (
        matchesInstalled
        || path.win32.basename(entry.nativeImagePath).toLowerCase() !== 'msedgewebview2.exe'
        || !/^[A-F0-9]{40}$/u.test(entry.signerThumbprint ?? '')
        || !/Microsoft Corporation/iu.test(entry.signerSubject ?? '')
      ) fail(`process closure ${entry.pid} Wry runtime identity is invalid`);
    } else {
      fail(`process closure ${entry.pid} has an unknown host runtime classification`);
    }
    if (closureByPid.has(entry.pid)) fail(`duplicate process closure PID ${entry.pid}`);
    closureByPid.set(entry.pid, entry);
  }
  const root = closureByPid.get(receipt.mainPid);
  if (!root || root.runtimeKind !== 'cef' || root.parentPid === root.pid) {
    fail('runtime process closure is not rooted at the receipt browser PID');
  }
  const rootCreationTime = BigInt(root.creationTime100ns);
  for (const entry of processClosure) {
    if (entry.pid === receipt.mainPid) continue;
    if (BigInt(entry.creationTime100ns) < rootCreationTime) {
      fail(`process closure descendant ${entry.pid} predates the browser root`);
    }
    if (!closureByPid.has(entry.parentPid)) {
      fail(`process closure ${entry.pid} omits its descendant parent`);
    }
    const visited = new Set([entry.pid]);
    let current = entry;
    while (current.pid !== receipt.mainPid) {
      if (visited.has(current.parentPid)) fail('runtime process closure contains a cycle');
      visited.add(current.parentPid);
      current = closureByPid.get(current.parentPid);
      if (!current) fail(`process closure ${entry.pid} is detached from the browser root`);
    }
    if (entry.runtimeKind === 'cef' && entry.parentPid !== receipt.mainPid) {
      fail(`same-executable CEF descendant ${entry.pid} is not a direct browser child`);
    }
  }
  const exactCefPids = processClosure
    .filter((entry) => entry.runtimeKind === 'cef')
    .map((entry) => entry.pid);
  const observedPids = processes.map((process) => process?.pid);
  if (JSON.stringify(observedPids) !== JSON.stringify(exactCefPids)) {
    fail('runtime process evidence does not cover the exact same-executable descendant set');
  }
  return closureByPid;
}

export function validateWindowsProcessSandboxEvidence(processClosure, processes, receipt, expected) {
  if (!Array.isArray(processes) || processes.length < 4) {
    fail('runtime process observation must include browser and CEF children');
  }
  if (
    receipt?.networkServiceSandboxFeature !== 'NetworkServiceSandbox'
    || receipt?.networkServiceSandboxRequested !== true
    || receipt?.networkServiceLpacFeature !== 'WinSboxNetworkServiceSandboxIsLPAC'
    || receipt?.networkServiceLpacRequested !== true
  ) fail('process evidence is not bound to the internal CEF NetworkServiceSandbox request');
  const closureByPid = validateWindowsProcessClosure(
    processClosure,
    processes,
    receipt,
    expected,
  );
  const pids = new Set();
  const seenTypes = new Set();
  const creationTimes = new Map();
  let browserCount = 0;
  let browserCreationTime;
  let networkServiceCount = 0;
  for (const process of processes) {
    exactKeys(process, [
      'pid', 'nativePid', 'parentPid', 'creationTime100ns', 'type', 'executablePath',
      'nativeImagePath', 'executableSha256', 'commandLine', 'utilitySubtype', 'inJob',
      'token', 'mitigations',
    ], 'runtime process observation');
    positiveInteger(process.pid, 'observed PID');
    if (process.nativePid !== process.pid) {
      fail(`process ${process.pid} native handle PID mismatch`);
    }
    if (pids.has(process.pid)) fail(`duplicate observed PID ${process.pid}`);
    pids.add(process.pid);
    const closureEntry = closureByPid.get(process.pid);
    if (
      !closureEntry
      || closureEntry.nativePid !== process.nativePid
      || closureEntry.parentPid !== process.parentPid
      || closureEntry.creationTime100ns !== process.creationTime100ns
      || !sameWindowsPath(closureEntry.nativeImagePath, process.nativeImagePath)
    ) fail(`process ${process.pid} does not match its stable descendant-closure identity`);
    if (!/^[1-9]\d{10,19}$/u.test(process.creationTime100ns ?? '')) {
      fail(`process ${process.pid} creation time is invalid`);
    }
    const creationTime = BigInt(process.creationTime100ns);
    creationTimes.set(process.pid, creationTime);
    if (!Number.isSafeInteger(process.parentPid) || process.parentPid < 0) {
      fail(`observed parent PID is invalid for ${process.pid}`);
    }
    if (!['browser', ...WINDOWS_MODE2_REQUIRED_PROCESS_TYPES].includes(process.type)) {
      fail(`unexpected CEF process type ${process.type}`);
    }
    seenTypes.add(process.type);
    exactWindowsPath(process.executablePath, `process ${process.pid} executable path`);
    exactWindowsPath(process.nativeImagePath, `process ${process.pid} native image path`);
    if (!sameWindowsPath(process.executablePath, process.nativeImagePath)) {
      fail(`process ${process.pid} executable path is not bound to its native image handle`);
    }
    if (!sameWindowsPath(process.executablePath, expected.installedExecutablePath)) {
      fail(`process ${process.pid} did not reuse the installed main executable`);
    }
    if (exactSha256(process.executableSha256, `process ${process.pid} executable`) !== expected.installedExecutableSha256) {
      fail(`process ${process.pid} executable digest mismatch`);
    }
    if (
      typeof process.commandLine !== 'string'
      || process.commandLine.length === 0
      || process.commandLine.length > 32_768
      || /\0/u.test(process.commandLine)
    ) {
      fail(`process ${process.pid} command line is invalid`);
    }
    if (/(?:^|\s)"?--no-sandbox"?(?:=|\s|$)|\bno_sandbox=1\b/iu.test(process.commandLine)) {
      fail(`process ${process.pid} used an unsandboxed command line`);
    }
    if (/(?:^|\s)"?--disable-(?:gpu-|seccomp-filter-|setuid-|namespace-)?sandbox"?(?:=|\s|$)/iu.test(process.commandLine)) {
      fail(`process ${process.pid} disabled a Chromium sandbox`);
    }
    const processType = process.commandLine.match(/(?:^|\s)--type=([^\s"]+)/u)?.[1];
    const commandUtilitySubtype = process.commandLine
      .match(/(?:^|\s)--utility-sub-type=([^\s"]+)/u)?.[1] ?? null;
    if (process.utilitySubtype !== commandUtilitySubtype) {
      fail(`process ${process.pid} utility subtype does not match its command line`);
    }
    if (typeof process.inJob !== 'boolean') fail(`process ${process.pid} job evidence is invalid`);
    validateTokenEvidence(process.token, process.type, process.utilitySubtype);
    validateMitigationEvidence(process.mitigations, process.type);
    if (process.type === 'browser') {
      browserCount += 1;
      browserCreationTime = creationTime;
      if (process.pid !== receipt.mainPid) {
        fail('browser process observation does not bind the runtime receipt PID');
      }
      if (processType !== undefined) fail('browser process unexpectedly carries a CEF child type');
      if (process.utilitySubtype !== null) fail('browser process carries a utility subtype');
    } else if (process.parentPid !== receipt.mainPid) {
      fail(`CEF ${process.type} process is outside the observed browser process tree`);
    } else if (processType !== process.type) {
      fail(`CEF ${process.type} observation does not match its command line`);
    } else if (!process.inJob) {
      fail(`CEF ${process.type} process is not assigned to a sandbox job`);
    } else if (process.type !== 'utility' && process.utilitySubtype !== null) {
      fail(`CEF ${process.type} unexpectedly carries a utility subtype`);
    }
    if (
      process.type === 'utility'
      && process.utilitySubtype === 'network.mojom.NetworkService'
    ) networkServiceCount += 1;
  }
  if (browserCount !== 1 || browserCreationTime === undefined) {
    fail('runtime process observation must include exactly one browser process');
  }
  for (const process of processes) {
    if (process.type !== 'browser' && creationTimes.get(process.pid) < browserCreationTime) {
      fail(`CEF ${process.type} process predates the observed browser process`);
    }
  }
  for (const required of ['browser', ...WINDOWS_MODE2_REQUIRED_PROCESS_TYPES]) {
    if (!seenTypes.has(required)) fail(`missing observed ${required} process`);
  }
  if (networkServiceCount !== 1) {
    fail('runtime process observation must include exactly one AppContainer NetworkService');
  }
}

function validateInstalledTreeSafety(safety, expected, installedTree) {
  exactKeys(safety, [
    'rootPath', 'rootType', 'rootNoReparsePoint', 'ancestorReparseFree', 'pathCount',
    'reparsePoints', 'alternateDataStreams', 'reservedPaths', 'unsupportedEntries',
  ], 'installed-tree safety proof');
  exactWindowsPath(safety.rootPath, 'installed-tree safety root');
  if (
    !sameWindowsPath(safety.rootPath, expected.installedRoot)
    || safety.rootType !== 'directory'
    || safety.rootNoReparsePoint !== true
    || safety.ancestorReparseFree !== true
    || safety.pathCount !== installedTree.pathCount
    || !['reparsePoints', 'alternateDataStreams', 'reservedPaths', 'unsupportedEntries']
      .every((field) => Array.isArray(safety[field]) && safety[field].length === 0)
  ) fail('installed-tree safety proof is incomplete');
  return safety;
}

function validateLpacAcl(acl, expected, installedTree) {
  exactKeys(acl, [
    'rootPath', 'sid', 'accessControlType', 'rights', 'objectInherit', 'containerInherit',
    'propagation', 'writeGranted', 'rootAceCount', 'rootExplicitAceCount',
    'descendantAcesInherited', 'descendantExplicitAceCount', 'rootNoReparsePoint',
    'ancestorReparseFree', 'verifiedDirectoryCount', 'verifiedFileCount',
    'verifiedPathCount', 'verifiedDirectories', 'verifiedFiles', 'missingPaths',
    'installedTreeInventorySha256', 'installedTreePathSetSha256',
  ], 'LPAC ACL observation');
  exactWindowsPath(acl.rootPath, 'LPAC ACL root path');
  if (!sameWindowsPath(acl.rootPath, expected.installedRoot)) fail('LPAC ACL root mismatch');
  if (
    acl.sid !== WINDOWS_LPAC_SID
    || acl.accessControlType !== 'Allow'
    || acl.rights !== 'read_execute'
    || acl.objectInherit !== true
    || acl.containerInherit !== true
    || acl.propagation !== 'none'
    || acl.writeGranted !== false
    || acl.rootAceCount !== 1
    || acl.rootExplicitAceCount !== 1
    || acl.descendantAcesInherited !== true
    || acl.descendantExplicitAceCount !== 0
    || acl.rootNoReparsePoint !== true
    || acl.ancestorReparseFree !== true
  ) {
    fail('LPAC ACL is not exact inherited read-execute');
  }
  if (
    acl.verifiedDirectoryCount !== installedTree.directoryCount
    || acl.verifiedFileCount !== installedTree.fileCount
    || acl.verifiedPathCount !== installedTree.pathCount
    || JSON.stringify(acl.verifiedDirectories) !== JSON.stringify(installedTree.directories)
    || JSON.stringify(acl.verifiedFiles) !== JSON.stringify(
      installedTree.files.map((file) => file.relativePath),
    )
    || acl.installedTreeInventorySha256 !== installedTree.inventorySha256
    || acl.installedTreePathSetSha256 !== installedTree.pathSetSha256
  ) {
    fail('LPAC ACL did not verify the exact full installed tree');
  }
  if (!Array.isArray(acl.missingPaths) || acl.missingPaths.length !== 0) {
    fail('LPAC ACL is missing an installed-tree path');
  }
}

function validateUpgradeAclSeed(seed, receipt, expected) {
  exactKeys(seed, [
    'nonce', 'runId', 'runAttempt', 'rootPath', 'sid', 'accessControlType',
    'rights', 'objectInherit', 'containerInherit', 'propagation', 'inherited',
    'writeGranted', 'aceCount', 'ancestorReparseFree',
  ], 'upgrade ACL seed observation');
  exactWindowsPath(seed.rootPath, 'upgrade ACL seed root');
  if (
    seed.nonce !== receipt.nonce
    || seed.runId !== expected.runId
    || seed.runAttempt !== expected.runAttempt
    || !sameWindowsPath(seed.rootPath, expected.installedRoot)
    || seed.sid !== WINDOWS_LPAC_SID
    || seed.accessControlType !== 'Allow'
    || seed.rights !== 'modify'
    || seed.objectInherit !== true
    || seed.containerInherit !== true
    || seed.propagation !== 'none'
    || seed.inherited !== false
    || seed.writeGranted !== true
    || seed.aceCount !== 1
    || seed.ancestorReparseFree !== true
  ) {
    fail('upgrade ACL seed is not bound to the exact current-run inherited Modify grant');
  }
  return seed;
}

function validateEvidenceAcl(evidenceAcl, expected) {
  exactKeys(evidenceAcl, [
    'rootPath', 'ownerSid', 'systemSid', 'inheritanceProtected', 'allowedSids',
    'aceCount', 'fullControlOnly', 'reparseFree',
  ], 'evidence-root ACL observation');
  exactWindowsPath(evidenceAcl.rootPath, 'evidence-root ACL path');
  const expectedEvidenceRoot = path.win32.join(expected.smokeRoot, 'evidence');
  if (
    !sameWindowsPath(evidenceAcl.rootPath, expectedEvidenceRoot)
    || !/^S-1-(?:\d+-)+\d+$/u.test(evidenceAcl.ownerSid ?? '')
    || evidenceAcl.systemSid !== WINDOWS_SYSTEM_SID
    || evidenceAcl.inheritanceProtected !== true
    || evidenceAcl.aceCount !== 2
    || evidenceAcl.fullControlOnly !== true
    || evidenceAcl.reparseFree !== true
    || JSON.stringify(evidenceAcl.allowedSids)
      !== JSON.stringify([WINDOWS_SYSTEM_SID, evidenceAcl.ownerSid].sort())
  ) fail('attested evidence root is not restricted to the runner owner and SYSTEM');
  return evidenceAcl;
}

export function validateWindowsMode2ProductionSmokeAttestation(attestation, expected) {
  exactKeys(expected, [
    'sourceCommit', 'appVersion', 'runId', 'runAttempt', 'installedRoot',
    'installedExecutablePath', 'installedExecutableSha256', 'installerSha256',
    'runtimeInventorySha256', 'verifiedPathCount', 'runtimeRelativePaths',
    'installedTreeInventorySha256', 'installedTreePathSetSha256',
    'installedTreePathCount', 'smokeRoot',
  ], 'attestation expectation');
  exactGitSha(expected.sourceCommit, 'expected source commit');
  exactRunNumber(expected.runId, 'expected run id');
  exactRunNumber(expected.runAttempt, 'expected run attempt');
  exactWindowsPath(expected.installedRoot, 'expected installed root');
  exactWindowsPath(expected.smokeRoot, 'expected smoke root');
  exactWindowsPath(expected.installedExecutablePath, 'expected installed executable');
  exactSha256(expected.installedExecutableSha256, 'expected installed executable');
  exactSha256(expected.installerSha256, 'expected installer');
  exactSha256(expected.runtimeInventorySha256, 'expected runtime inventory');
  exactSha256(expected.installedTreeInventorySha256, 'expected installed-tree inventory');
  exactSha256(expected.installedTreePathSetSha256, 'expected installed-tree path set');
  positiveInteger(expected.verifiedPathCount, 'expected verified path count');
  positiveInteger(expected.installedTreePathCount, 'expected installed-tree path count');
  const expectedRuntimeRelativePaths = validateRuntimeRelativePaths(
    expected.runtimeRelativePaths,
    'expected runtime relative paths',
  );
  if (expectedRuntimeRelativePaths.length !== expected.verifiedPathCount) {
    fail('expected runtime relative path count mismatch');
  }

  exactKeys(attestation, [
    'schemaVersion', 'platform', 'sourceCommit', 'appVersion', 'run', 'installed',
    'runtime', 'upgradeAclSeed', 'evidenceAcl', 'lpacAcl', 'cleanup',
  ], 'Windows Mode 2 production smoke attestation');
  if (attestation.schemaVersion !== WINDOWS_MODE2_SMOKE_SCHEMA_VERSION) fail('attestation schema version mismatch');
  if (attestation.platform !== WINDOWS_MODE2_SMOKE_PLATFORM) fail('attestation platform mismatch');
  if (exactGitSha(attestation.sourceCommit, 'attestation source commit') !== expected.sourceCommit) {
    fail('attestation source commit mismatch');
  }
  if (attestation.appVersion !== expected.appVersion) fail('attestation app version mismatch');
  exactKeys(attestation.run, ['id', 'attempt', 'smokeRoot'], 'attestation run');
  if (attestation.run.id !== expected.runId || attestation.run.attempt !== expected.runAttempt) {
    fail('attestation GitHub run identity mismatch');
  }
  exactWindowsPath(attestation.run.smokeRoot, 'attestation smoke root');
  if (!sameWindowsPath(attestation.run.smokeRoot, expected.smokeRoot)) {
    fail('attestation smoke root mismatch');
  }
  exactKeys(attestation.installed, [
    'root', 'executablePath', 'executableSha256', 'installerSha256', 'runtimeInventorySha256',
    'installedTree', 'installedTreeSafety',
  ], 'attestation installed identity');
  for (const [actual, wanted, label] of [
    [attestation.installed.root, expected.installedRoot, 'installed root'],
    [attestation.installed.executablePath, expected.installedExecutablePath, 'installed executable'],
  ]) {
    exactWindowsPath(actual, label);
    if (!sameWindowsPath(actual, wanted)) fail(`${label} mismatch`);
  }
  if (attestation.installed.executableSha256 !== expected.installedExecutableSha256) {
    fail('installed executable digest mismatch');
  }
  if (attestation.installed.installerSha256 !== expected.installerSha256) {
    fail('installed installer digest mismatch');
  }
  if (attestation.installed.runtimeInventorySha256 !== expected.runtimeInventorySha256) {
    fail('installed runtime inventory digest mismatch');
  }
  const installedTree = validateWindowsInstalledTreeInventory(
    attestation.installed.installedTree,
    'attested installed tree',
  );
  if (
    installedTree.inventorySha256 !== expected.installedTreeInventorySha256
    || installedTree.pathSetSha256 !== expected.installedTreePathSetSha256
    || installedTree.pathCount !== expected.installedTreePathCount
  ) fail('attested installed tree does not match the current-run preflight inventory');
  validateInstalledTreeSafety(
    attestation.installed.installedTreeSafety,
    expected,
    installedTree,
  );

  exactKeys(attestation.runtime, [
    'receipt', 'receiptSha256', 'window', 'processClosure', 'processes',
  ], 'runtime observation');
  const receipt = validateRuntimeReceipt(attestation.runtime.receipt, expected);
  if (
    exactSha256(attestation.runtime.receiptSha256, 'runtime receipt')
    !== hashWindowsMode2SmokeJson(receipt)
  ) {
    fail('runtime receipt digest does not bind the attested receipt');
  }
  validateWindowsNativeWindowObservation(
    attestation.runtime.window,
    receipt.productionPath.nativeWindow,
  );
  validateWindowsProcessSandboxEvidence(
    attestation.runtime.processClosure,
    attestation.runtime.processes,
    receipt,
    expected,
  );
  validateUpgradeAclSeed(attestation.upgradeAclSeed, receipt, expected);
  validateEvidenceAcl(attestation.evidenceAcl, expected);
  validateLpacAcl(attestation.lpacAcl, expected, installedTree);
  if (
    attestation.upgradeAclSeed.sid !== attestation.lpacAcl.sid
    || !sameWindowsPath(attestation.upgradeAclSeed.rootPath, attestation.lpacAcl.rootPath)
    || attestation.upgradeAclSeed.writeGranted !== true
    || attestation.lpacAcl.writeGranted !== false
    || attestation.upgradeAclSeed.ancestorReparseFree !== true
    || attestation.lpacAcl.ancestorReparseFree !== true
  ) {
    fail('LPAC upgrade proof did not narrow the seeded write grant to read-execute');
  }
  exactKeys(attestation.cleanup, [
    'mainExitCode', 'observedClosurePids', 'remainingOwnedPids', 'remainingClosurePids',
  ], 'cleanup observation');
  if (attestation.cleanup.mainExitCode !== 0) fail('installed smoke app did not exit cleanly');
  if (
    JSON.stringify(attestation.cleanup.observedClosurePids)
      !== JSON.stringify(attestation.runtime.processClosure.map((entry) => entry.pid))
    || !Array.isArray(attestation.cleanup.remainingOwnedPids)
    || attestation.cleanup.remainingOwnedPids.length !== 0
    || !Array.isArray(attestation.cleanup.remainingClosurePids)
    || attestation.cleanup.remainingClosurePids.length !== 0
  ) {
    fail('observed CEF or Wry host processes remained after the installed smoke');
  }

  return {
    schemaVersion: WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
    platform: WINDOWS_MODE2_SMOKE_PLATFORM,
    sourceCommit: expected.sourceCommit,
    appVersion: expected.appVersion,
    runId: expected.runId,
    runAttempt: expected.runAttempt,
    installedExecutableSha256: expected.installedExecutableSha256,
    installerSha256: expected.installerSha256,
    runtimeInventorySha256: expected.runtimeInventorySha256,
    installedTreeInventorySha256: expected.installedTreeInventorySha256,
    installedTreePathSetSha256: expected.installedTreePathSetSha256,
    installedTreePathCount: expected.installedTreePathCount,
    runtimeReceiptSha256: attestation.runtime.receiptSha256,
    chromiumVersion: WINDOWS_MODE2_CHROMIUM_VERSION,
    sandboxProfile: WINDOWS_MODE2_SANDBOX_PROFILE,
    processTypes: [...WINDOWS_MODE2_REQUIRED_PROCESS_TYPES],
    stages: [...WINDOWS_MODE2_REQUIRED_STAGES],
    lpacSid: WINDOWS_LPAC_SID,
    verifiedPathCount: expected.verifiedPathCount,
    verifiedPathsSha256: hashWindowsMode2SmokeJson(expectedRuntimeRelativePaths),
    productionPathVerified: true,
    nativeWindowVerified: true,
    processTokenSandboxVerified: true,
    networkServiceSandboxed: true,
    upgradeAclNarrowed: true,
    observedDpi: attestation.runtime.window.dpi,
    profileCleanupVerified: true,
    cleanExit: true,
  };
}

export function validateWindowsMode2SmokeSummary(summary, expected) {
  exactKeys(summary, [
    'schemaVersion', 'platform', 'sourceCommit', 'appVersion', 'runId', 'runAttempt',
    'installedExecutableSha256', 'installerSha256', 'runtimeInventorySha256',
    'installedTreeInventorySha256', 'installedTreePathSetSha256',
    'installedTreePathCount', 'runtimeReceiptSha256', 'attestationSha256',
    'chromiumVersion', 'sandboxProfile',
    'processTypes', 'stages', 'lpacSid',
    'verifiedPathCount', 'verifiedPathsSha256', 'productionPathVerified',
    'nativeWindowVerified', 'processTokenSandboxVerified', 'networkServiceSandboxed',
    'upgradeAclNarrowed', 'observedDpi', 'profileCleanupVerified', 'cleanExit',
  ], 'Windows Mode 2 smoke summary');
  if (
    summary.schemaVersion !== WINDOWS_MODE2_SMOKE_SCHEMA_VERSION
    || summary.platform !== WINDOWS_MODE2_SMOKE_PLATFORM
    || summary.sourceCommit !== expected.sourceCommit
    || summary.appVersion !== expected.appVersion
    || summary.installedTreeInventorySha256 !== expected.installedTreeInventorySha256
    || summary.installedTreePathSetSha256 !== expected.installedTreePathSetSha256
    || summary.installedTreePathCount !== expected.installedTreePathCount
    || summary.cleanExit !== true
    || summary.productionPathVerified !== true
    || summary.nativeWindowVerified !== true
    || summary.processTokenSandboxVerified !== true
    || summary.networkServiceSandboxed !== true
    || summary.upgradeAclNarrowed !== true
    || summary.profileCleanupVerified !== true
    || summary.chromiumVersion !== WINDOWS_MODE2_CHROMIUM_VERSION
    || summary.sandboxProfile !== WINDOWS_MODE2_SANDBOX_PROFILE
    || summary.lpacSid !== WINDOWS_LPAC_SID
    || JSON.stringify(summary.processTypes) !== JSON.stringify(WINDOWS_MODE2_REQUIRED_PROCESS_TYPES)
    || JSON.stringify(summary.stages) !== JSON.stringify(WINDOWS_MODE2_REQUIRED_STAGES)
  ) {
    fail('Windows Mode 2 smoke summary is incomplete or mismatched');
  }
  for (const field of [
    'installedExecutableSha256', 'installerSha256', 'runtimeInventorySha256',
    'installedTreeInventorySha256', 'installedTreePathSetSha256',
    'runtimeReceiptSha256', 'attestationSha256', 'verifiedPathsSha256',
  ]) exactSha256(summary[field], `smoke summary ${field}`);
  exactRunNumber(summary.runId, 'smoke summary run id');
  exactRunNumber(summary.runAttempt, 'smoke summary run attempt');
  positiveInteger(summary.verifiedPathCount, 'smoke summary verified path count');
  positiveInteger(summary.installedTreePathCount, 'smoke summary installed-tree path count');
  if (!Number.isSafeInteger(summary.observedDpi) || summary.observedDpi < 96 || summary.observedDpi > 960) {
    fail('smoke summary observed DPI is invalid');
  }
  return summary;
}
