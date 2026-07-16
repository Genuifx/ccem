import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  WINDOWS_MODE2_SMOKE_ALLOW_ENV,
  WINDOWS_POWERSHELL_PATH,
  assertWindowsMode2SmokeAuthorization,
  createObservationAck,
  createWindowsEvidenceRootAclCommand,
  createWindowsMode2SmokePlan,
  createWindowsOwnedProcessCommand,
  createWindowsPreflightInspectionCommand,
  createWindowsProcessObservationCommand,
  createWindowsUpgradeAclSeedCommand,
  executeWindowsMode2ProductionSmoke,
  run,
  validatePreflightObservation,
  validateWindowsEvidenceRootAclObservation,
  validateWindowsUpgradeAclSeedObservation,
  validateWindowsMode2StageManifest,
} from '../scripts/run-windows-mode2-production-smoke.mjs';
import {
  WINDOWS_MODE2_REQUIRED_STAGES,
  WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
  createWindowsInstalledTreeInventory,
  createWindowsRuntimeInventoryFingerprint,
  hashWindowsMode2SmokeJson,
  validateWindowsInstalledTreeInventory,
  validateWindowsProcessSandboxEvidence,
} from '../scripts/windows-mode2-production-smoke-contract.mjs';
import { WINDOWS_CEF_SOURCE_PIN } from '../scripts/stage-cef-windows.mjs';

const SOURCE_COMMIT = 'a'.repeat(40);
const NONCE = 'b'.repeat(64);
const INSTALLER_SHA = 'c'.repeat(64);
const EXECUTABLE_SHA = 'd'.repeat(64);
const THUMBPRINT = 'A'.repeat(40);
const TIMESTAMP_THUMBPRINT = 'E'.repeat(40);
const PUBLISHER = 'CN=CCEM Release, O=CCEM';
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environment = {
  GITHUB_ACTIONS: 'true',
  RUNNER_OS: 'Windows',
  RUNNER_TEMP: 'D:\\a\\_temp',
  GITHUB_SHA: SOURCE_COMMIT,
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '2',
  WINDOWS_CERTIFICATE_THUMBPRINT: THUMBPRINT,
  CCEM_OFFICIAL_WINDOWS_PUBLISHER: PUBLISHER,
  [WINDOWS_MODE2_SMOKE_ALLOW_ENV]: '1',
};

function fixturePlan() {
  return createWindowsMode2SmokePlan({
    environment,
    installerPath: 'D:\\a\\ccem\\ccem_2.53.0_x64-setup.exe',
    stageDir: 'D:\\a\\ccem\\cef-stage',
    appVersion: '2.53.0',
    sourceCommit: SOURCE_COMMIT,
    nonce: NONCE,
    outputPath: 'D:\\a\\_temp\\ccem-mode2-production-smoke\\12345-2\\evidence\\windows-mode2-production-smoke-attestation.json',
  });
}

const stableCefResources = {
  'cef-windows-sandbox-artifact.json': '1'.repeat(64),
  'ccem-desktop.dll': '2'.repeat(64),
  'chrome_elf.dll': '3'.repeat(64),
  'locales/en-US.pak': '4'.repeat(64),
};

const manifestIdentity = {
  stableCefResources,
  signer: {
    thumbprint: THUMBPRINT,
    publisher: PUBLISHER,
    signedFiles: ['ccem-desktop.dll', 'chrome_elf.dll'],
  },
};

function signature(path) {
  return {
    path,
    status: 'Valid',
    signerThumbprint: THUMBPRINT,
    signerSubject: PUBLISHER,
    timestampThumbprint: TIMESTAMP_THUMBPRINT,
  };
}

function fixturePreflight(plan) {
  const fingerprint = createWindowsRuntimeInventoryFingerprint({
    installedExecutableSha256: EXECUTABLE_SHA,
    stableCefResources,
  });
  const installedTree = fixtureInstalledTree(plan);
  return {
    installerSha256: INSTALLER_SHA,
    installedExecutableSha256: EXECUTABLE_SHA,
    stableCefResources,
    authenticode: [
      signature(plan.paths.installerPath),
      signature(plan.paths.installedExecutablePath),
      signature(`${plan.paths.installRoot}\\ccem-desktop.dll`),
      signature(`${plan.paths.installRoot}\\chrome_elf.dll`),
    ],
    installedTree: {
      directories: installedTree.directories,
      files: installedTree.files,
    },
    installedTreeSafety: {
      rootPath: plan.paths.installRoot,
      rootType: 'directory',
      rootNoReparsePoint: true,
      ancestorReparseFree: true,
      pathCount: installedTree.pathCount,
      reparsePoints: [],
      alternateDataStreams: [],
      reservedPaths: [],
      unsupportedEntries: [],
    },
    lpacAcl: {
      rootPath: plan.paths.installRoot,
      sid: 'S-1-15-2-2',
      accessControlType: 'Allow',
      rights: 'read_execute',
      objectInherit: true,
      containerInherit: true,
      propagation: 'none',
      writeGranted: false,
      rootAceCount: 1,
      rootExplicitAceCount: 1,
      descendantAcesInherited: true,
      descendantExplicitAceCount: 0,
      rootNoReparsePoint: true,
      ancestorReparseFree: true,
      verifiedDirectoryCount: installedTree.directoryCount,
      verifiedFileCount: installedTree.fileCount,
      verifiedPathCount: installedTree.pathCount,
      verifiedDirectories: installedTree.directories,
      verifiedFiles: installedTree.files.map((file) => file.relativePath),
      missingPaths: [],
    },
  };
}

function fixtureInstalledTree(plan) {
  return createWindowsInstalledTreeInventory({
    directories: ['binaries', 'locales', 'resources'],
    files: [
      { relativePath: 'ccem-desktop.exe', size: 4096, sha256: EXECUTABLE_SHA },
      ...Object.entries(stableCefResources).map(([relativePath, sha256], index) => ({
        relativePath,
        size: 512 + index,
        sha256,
      })),
      { relativePath: 'binaries/ccem-node.exe', size: 8192, sha256: 'e'.repeat(64) },
      { relativePath: 'resources/native-runtime-helper.mjs', size: 2048, sha256: 'f'.repeat(64) },
      { relativePath: 'uninstall.exe', size: 1024, sha256: '9'.repeat(64) },
    ],
  });
}

function fixtureEvidenceAcl(plan) {
  return {
    rootPath: plan.paths.evidenceRoot,
    ownerSid: 'S-1-5-21-1000-1000-1000-1001',
    systemSid: 'S-1-5-18',
    inheritanceProtected: true,
    allowedSids: ['S-1-5-18', 'S-1-5-21-1000-1000-1000-1001'],
    aceCount: 2,
    fullControlOnly: true,
    reparseFree: true,
  };
}

function fixtureCleanedProcesses() {
  return { remainingOwnedPids: [], remainingClosurePids: [] };
}

function fixtureUpgradeAclSeed(plan) {
  return {
    nonce: plan.nonce,
    runId: plan.run.id,
    runAttempt: plan.run.attempt,
    rootPath: plan.paths.installRoot,
    sid: 'S-1-15-2-2',
    accessControlType: 'Allow',
    rights: 'modify',
    objectInherit: true,
    containerInherit: true,
    propagation: 'none',
    inherited: false,
    writeGranted: true,
    aceCount: 1,
    ancestorReparseFree: true,
  };
}

function fixtureCheckpoint(plan) {
  const profileId = `profile-${'e'.repeat(32)}`;
  return {
    schemaVersion: WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
    nonce: NONCE,
    sourceCommit: SOURCE_COMMIT,
    appVersion: plan.appVersion,
    runId: plan.run.id,
    runAttempt: plan.run.attempt,
    mainPid: 4242,
    executablePath: plan.paths.installedExecutablePath,
    sandboxEnabled: true,
    networkServiceSandboxFeature: 'NetworkServiceSandbox',
    networkServiceSandboxRequested: true,
    networkServiceLpacFeature: 'WinSboxNetworkServiceSandboxIsLPAC',
    networkServiceLpacRequested: true,
    productionPath: {
      verified: true,
      manager: 'LoginBrowserSurfaceManager',
      dataRoot: `${plan.paths.smokeRoot}\\data`,
      workspaceRoot: `${plan.paths.smokeRoot}\\workspace`,
      ownerRecordRoot: `${plan.paths.smokeRoot}\\data\\login\\embedded-owners`,
      profileStateRoot: `${plan.paths.smokeRoot}\\data\\login\\profile-state`,
      cefCacheRoot: `${plan.paths.smokeRoot}\\data\\login\\cef`,
      profileId,
      nativeWindow: fixtureWindow(),
    },
    stages: WINDOWS_MODE2_REQUIRED_STAGES.slice(0, 7).map((name, index) => ({
      name,
      monotonicMs: (index + 1) * 10,
    })),
  };
}

function fixtureWindow() {
  return {
    hwnd: '0x1234',
    parentHwnd: '0x4321',
    ownerPid: 4242,
    x: 180,
    y: 150,
    width: 1080,
    height: 720,
    parentClientWidth: 1920,
    parentClientHeight: 1080,
    visible: true,
    dpi: 144,
  };
}

function fixtureReceipt(plan, checkpoint) {
  return {
    schemaVersion: WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
    nonce: NONCE,
    sourceCommit: SOURCE_COMMIT,
    appVersion: plan.appVersion,
    mainPid: checkpoint.mainPid,
    executablePath: plan.paths.installedExecutablePath,
    sandboxEnabled: true,
    networkServiceSandboxFeature: 'NetworkServiceSandbox',
    networkServiceSandboxRequested: true,
    networkServiceLpacFeature: 'WinSboxNetworkServiceSandboxIsLPAC',
    networkServiceLpacRequested: true,
    productionPath: {
      ...checkpoint.productionPath,
      semantic: {
        readViaCapability: true,
        writeViaCapability: true,
        writeObserved: true,
        postPauseWriteDenied: true,
        postPauseValueUnchanged: true,
      },
      reopenedProfileId: checkpoint.productionPath.profileId,
      cleanup: {
        activeSurfaceCount: 0,
        activeSessionCount: 0,
        ownerRecordCount: 0,
        persistedProfileCount: 1,
        profileLockAvailable: true,
      },
    },
    stages: WINDOWS_MODE2_REQUIRED_STAGES.map((name, index) => ({
      name,
      monotonicMs: (index + 1) * 10,
    })),
  };
}

function fixtureProcesses(plan) {
  const executable = plan.paths.installedExecutablePath;
  const token = ({
    integrityRid,
    isRestricted,
    isAppContainer = false,
    isLessPrivilegedAppContainer = false,
    appContainerSid = null,
    restrictedSids = [],
    capabilitySids = [],
    groupSids = ['S-1-5-32-545'],
  }) => ({
    isAppContainer,
    isLessPrivilegedAppContainer,
    appContainerSid,
    integritySid: `S-1-16-${integrityRid}`,
    integrityRid,
    isRestricted,
    restrictedSidCount: restrictedSids.length,
    restrictedSids,
    capabilitySidCount: capabilitySids.length,
    capabilitySids,
    groupSidCount: groupSids.length,
    groupSids,
  });
  const mitigations = (overrides = {}) => ({
    depEnabled: true,
    bottomUpAslr: true,
    highEntropyAslr: true,
    dynamicCodeProhibited: false,
    strictHandleChecks: true,
    win32kSystemCallsDisabled: false,
    extensionPointsDisabled: true,
    controlFlowGuardEnabled: true,
    ...overrides,
  });
  const observedProcess = ({ pid, parentPid, creationTime100ns, ...fields }) => ({
    pid,
    nativePid: pid,
    parentPid,
    creationTime100ns,
    executablePath: executable,
    nativeImagePath: executable,
    executableSha256: EXECUTABLE_SHA,
    ...fields,
  });
  return [
    observedProcess({ pid: 4242, parentPid: 911, creationTime100ns: '133800000000000000', type: 'browser', utilitySubtype: null, commandLine: `"${executable}"`, inJob: true, token: token({ integrityRid: 8192, isRestricted: false }), mitigations: mitigations({ extensionPointsDisabled: false }) }),
    observedProcess({ pid: 4243, parentPid: 4242, creationTime100ns: '133800000000000001', type: 'renderer', utilitySubtype: null, commandLine: `"${executable}" --type=renderer`, inJob: true, token: token({ integrityRid: 0, isRestricted: true, restrictedSids: ['S-1-5-12'] }), mitigations: mitigations({ win32kSystemCallsDisabled: true }) }),
    observedProcess({ pid: 4244, parentPid: 4242, creationTime100ns: '133800000000000002', type: 'gpu-process', utilitySubtype: null, commandLine: `"${executable}" --type=gpu-process`, inJob: true, token: token({ integrityRid: 4096, isRestricted: true, restrictedSids: ['S-1-5-12'] }), mitigations: mitigations() }),
    observedProcess({ pid: 4245, parentPid: 4242, creationTime100ns: '133800000000000003', type: 'utility', utilitySubtype: 'network.mojom.NetworkService', commandLine: `"${executable}" --type=utility --utility-sub-type=network.mojom.NetworkService`, inJob: true, token: token({ integrityRid: 4096, isRestricted: true, isAppContainer: true, isLessPrivilegedAppContainer: true, appContainerSid: 'S-1-15-2-1234', capabilitySids: ['S-1-15-3-1'], groupSids: ['S-1-15-2-2', 'S-1-5-32-545'] }), mitigations: mitigations() }),
  ];
}

function fixtureObservation(plan) {
  const processes = fixtureProcesses(plan);
  return {
    window: fixtureWindow(),
    processClosure: [
      ...processes.map((entry) => ({
        pid: entry.pid,
        nativePid: entry.nativePid,
        parentPid: entry.parentPid,
        creationTime100ns: entry.creationTime100ns,
        nativeImagePath: entry.nativeImagePath,
        runtimeKind: 'cef',
        signerThumbprint: null,
        signerSubject: null,
      })),
      {
        pid: 4246,
        nativePid: 4246,
        parentPid: 4242,
        creationTime100ns: '133800000000000004',
        nativeImagePath: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\150.0.1\\msedgewebview2.exe',
        runtimeKind: 'wry-webview2',
        signerThumbprint: 'F'.repeat(40),
        signerSubject: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US',
      },
    ],
    processes,
  };
}

test('plan pins the exact current-run app/evidence roots and safe NSIS invocation', () => {
  const plan = fixturePlan();
  assert.equal(plan.paths.smokeRoot, 'D:\\a\\_temp\\ccem-mode2-production-smoke\\12345-2');
  assert.equal(plan.paths.installRoot, `${plan.paths.smokeRoot}\\app`);
  assert.equal(plan.paths.evidenceRoot, `${plan.paths.smokeRoot}\\evidence`);
  assert.deepEqual(plan.install, {
    program: 'D:\\a\\ccem\\ccem_2.53.0_x64-setup.exe',
    args: ['/S', `/D=${plan.paths.installRoot}`],
  });
  assert.equal(plan.launch.environment.CCEM_WINDOWS_MODE2_SMOKE_ALLOW, '1');
  assert.equal(plan.launch.environment.CCEM_WINDOWS_MODE2_SMOKE_OBSERVATION_PATH, plan.paths.observationPath);
  assert.equal(plan.launch.environment.CCEM_WINDOWS_MODE2_SMOKE_ACK_PATH, plan.paths.ackPath);
  assert.equal(plan.launch.environment.CCEM_WINDOWS_MODE2_SMOKE_RECEIPT_PATH, plan.paths.receiptPath);
});

test('installed smoke source enters the production manager path with isolated state and exact lifecycle', async () => {
  const [runtime, surfaceBridge, desktop, windowsBootstrap] = await Promise.all([
    fs.readFile(path.join(
      desktopDir,
      'src-tauri/src/browser/login/cef/ci_smoke/production_runtime.rs',
    ), 'utf8'),
    fs.readFile(path.join(
      desktopDir,
      'src-tauri/src/browser/login/surface_commands/production_smoke.rs',
    ), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri/src/lib.rs'), 'utf8'),
    fs.readFile(path.join(
      desktopDir,
      'src-tauri/src/browser/login/cef/bootstrap/windows.rs',
    ), 'utf8'),
  ]);
  const ordered = [
    'production_acquired_hidden_ready',
    'production_shown',
    'production_hidden',
    'production_reshown',
    'BrowserSurfaceControlActionArg::Handoff',
    'BrowserSurfaceControlActionArg::Pause',
    'BrowserSurfaceControlActionArg::Takeover',
    'production_released',
    'production_reopened_ready',
    'production_reopened_shown',
    'production_reclosed',
    'production_cleanup_verified',
  ];
  let cursor = -1;
  for (const marker of ordered) {
    const next = runtime.indexOf(marker, cursor + 1);
    assert.notEqual(next, -1, `missing production lifecycle marker ${marker}`);
    cursor = next;
  }
  assert.match(surfaceBridge, /snapshot\.lifecycle != "ready"[\s\S]*snapshot\.visible/);
  assert.match(surfaceBridge, /snapshot\.visible != visible/);
  assert.match(surfaceBridge, /native\.current_url != expected_initial_url/);
  for (const owner of ['Agent', 'Paused', 'User']) {
    assert.match(surfaceBridge, new RegExp(`SessionControlOwner::${owner}`));
  }
  assert.match(surfaceBridge, /session\.control != expected_control/);
  assert.match(runtime, /profile_state_root[\s\S]*profile\.lock/);
  assert.match(runtime, /owner_record_count != 0/);
  assert.match(runtime, /list_snapshots\(\)/);
  assert.match(desktop, /config\.create_isolated_runtime\(\)/);
  assert.match(desktop, /runtime\.sessions\.clone\(\)/);
  assert.match(desktop, /runtime\.surfaces\.clone\(\)/);
  assert.match(desktop, /runtime\.cef_host\.clone\(\)/);
  assert.match(windowsBootstrap, /NETWORK_SERVICE_SANDBOX_FEATURE: &str = "NetworkServiceSandbox"/);
  assert.match(windowsBootstrap, /NETWORK_SERVICE_LPAC_FEATURE: &str =[\s\S]*"WinSboxNetworkServiceSandboxIsLPAC"/);
  assert.match(windowsBootstrap, /switch_value\(Some\(&name\)\)/);
  assert.match(windowsBootstrap, /features\.push\(NETWORK_SERVICE_SANDBOX_FEATURE\.to_string\(\)\)/);
  assert.match(windowsBootstrap, /features\.push\(NETWORK_SERVICE_LPAC_FEATURE\.to_string\(\)\)/);
  assert.match(windowsBootstrap, /append_switch_with_value\(Some\(&name\), Some\(&features\)\)/);
});

test('real execution requires both Windows GitHub runner identity and explicit authorization', () => {
  assert.throws(() => assertWindowsMode2SmokeAuthorization(environment, 'darwin'), /GitHub Actions Windows runner/);
  assert.throws(() => assertWindowsMode2SmokeAuthorization({ ...environment, [WINDOWS_MODE2_SMOKE_ALLOW_ENV]: '0' }, 'win32'), /explicitly authorized/);
  assert.equal(assertWindowsMode2SmokeAuthorization(environment, 'win32'), true);
});

test('dry-run stays pure on macOS and never enters injected execution dependencies', async () => {
  let output = '';
  const result = await run([
    '--dry-run', '--installer', 'D:\\a\\ccem\\ccem_2.53.0_x64-setup.exe',
    '--stage', 'D:\\a\\ccem\\cef-stage', '--version', '2.53.0',
    '--source-commit', SOURCE_COMMIT,
  ], {
    environment,
    platform: 'darwin',
    dependencies: new Proxy({}, { get: () => () => { throw new Error('side effect'); } }),
    writeOutput: (value) => { output += value; },
  });
  assert.equal(result.status, 'dry-run');
  assert.match(output, /"status"|"platform"/);
});

test('stage manifest is bound to exact current run and pinned signer', () => {
  const plan = fixturePlan();
  const manifest = {
    schemaVersion: 4,
    target: 'x86_64-pc-windows-msvc',
    profile: 'release',
    sourceCommit: SOURCE_COMMIT,
    sourcePin: WINDOWS_CEF_SOURCE_PIN,
    provenance: { source: 'runner-temp-current-run', runId: '12345', runAttempt: '2' },
    files: Object.keys(stableCefResources),
    hashes: stableCefResources,
    signer: { ...manifestIdentity.signer, timestamped: true },
  };
  assert.deepEqual(validateWindowsMode2StageManifest(manifest, plan, environment), manifestIdentity);
  assert.throws(() => validateWindowsMode2StageManifest({
    ...manifest,
    files: [...manifest.files, manifest.files[0]],
  }, plan, environment), /inventory is incomplete/);
  assert.throws(() => validateWindowsMode2StageManifest({
    ...manifest,
    signer: { ...manifest.signer, signedFiles: [...manifest.signer.signedFiles, manifest.signer.signedFiles[0]] },
  }, plan, environment), /contains duplicates/);
});

test('preflight rejects any unsigned or mismatched Authenticode member', () => {
  const plan = fixturePlan();
  const preflight = fixturePreflight(plan);
  preflight.authenticode[0] = { ...preflight.authenticode[0], status: 'NotSigned' };
  assert.throws(() => validatePreflightObservation(preflight, plan, manifestIdentity), /Authenticode identity is invalid/);
});

test('installed-tree inventory is semantic, complete, and independent of JSON key order', () => {
  const canonical = fixtureInstalledTree(fixturePlan());
  const reordered = {
    files: canonical.files.map((file) => ({
      sha256: file.sha256,
      size: file.size,
      relativePath: file.relativePath,
    })),
    directories: canonical.directories,
    inventorySha256: canonical.inventorySha256,
    pathSetSha256: canonical.pathSetSha256,
    fileCount: canonical.fileCount,
    directoryCount: canonical.directoryCount,
    pathCount: canonical.pathCount,
    schemaVersion: canonical.schemaVersion,
  };
  assert.deepEqual(
    validateWindowsInstalledTreeInventory(reordered),
    reordered,
  );
  const aliased = {
    ...canonical,
    directories: [...canonical.directories.slice(0, -1), 'RESOURCES', 'resources'],
  };
  assert.throws(
    () => validateWindowsInstalledTreeInventory(aliased),
    /case-insensitive duplicate/,
  );
});

test('PowerShell plans use structured Authenticode, ACL and CIM inspection only', () => {
  const plan = fixturePlan();
  const checkpoint = fixtureCheckpoint(plan);
  const seedCommand = createWindowsUpgradeAclSeedCommand({ plan });
  const evidenceCommand = createWindowsEvidenceRootAclCommand({ plan });
  const commands = [
    createWindowsPreflightInspectionCommand({ plan, ...manifestIdentity }),
    createWindowsProcessObservationCommand({ plan, checkpoint }),
    createWindowsOwnedProcessCommand(plan),
  ];
  for (const command of [evidenceCommand, seedCommand, ...commands]) {
    assert.equal(command.program, WINDOWS_POWERSHELL_PATH);
    assert.deepEqual(command.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  }
  const source = commands.map((command) => Buffer.from(command.args[3], 'base64').toString('utf16le')).join('\n');
  const evidenceSource = Buffer.from(evidenceCommand.args[3], 'base64').toString('utf16le');
  const seedSource = Buffer.from(seedCommand.args[3], 'base64').toString('utf16le');
  const nativeSourceBase64 = source.match(
    /\$nativeSource = \[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/u,
  )?.[1];
  assert.ok(nativeSourceBase64, 'native Win32 evidence source must be embedded');
  const inspectedSource = `${source}\n${Buffer.from(nativeSourceBase64, 'base64').toString('utf8')}`;
  assert.match(inspectedSource, /Get-AuthenticodeSignature/);
  assert.match(inspectedSource, /Get-Acl/);
  assert.match(inspectedSource, /SecurityIdentifier/);
  assert.match(inspectedSource, /Get-CimInstance/);
  assert.match(inspectedSource, /GetTokenInformation/);
  assert.match(inspectedSource, /GetProcessMitigationPolicy/);
  assert.match(inspectedSource, /PROCESS_QUERY_LIMITED_INFORMATION = 0x1000/);
  assert.match(inspectedSource, /PROCESS_QUERY_INFORMATION = 0x0400/);
  assert.match(inspectedSource, /RequireMitigationProcess[\s\S]*PROCESS_QUERY_INFORMATION/);
  assert.match(inspectedSource, /TokenIsLessPrivilegedAppContainer = 46/);
  assert.match(inspectedSource, /IsProcessInJob/);
  assert.match(inspectedSource, /GetProcessTimes/);
  assert.match(inspectedSource, /QueryFullProcessImageName/);
  assert.match(inspectedSource, /Get-FileHash -Algorithm SHA256 -LiteralPath \(\[string\]\$identityAfter\.nativeImagePath\)/);
  assert.match(inspectedSource, /GetDpiForWindow/);
  assert.match(inspectedSource, /GetWindowDpiAwarenessContext/);
  assert.match(inspectedSource, /SetThreadDpiAwarenessContext\(targetDpiContext\)/);
  assert.match(inspectedSource, /SetThreadDpiAwarenessContext\(previousDpiContext\)/);
  assert.match(inspectedSource, /ReadWindow/);
  assert.match(inspectedSource, /function Assert-NoReparsePath/);
  assert.match(inspectedSource, /runtime path contains a reparse point/);
  assert.match(inspectedSource, /Assert-NoReparsePath \$candidate/g);
  assert.match(inspectedSource, /Assert-NoReparseAncestors \$installRoot/);
  assert.match(inspectedSource, /Get-ChildItem -LiteralPath \$current -Force/);
  assert.match(inspectedSource, /Get-Item -LiteralPath \$candidate -Stream \*/);
  assert.match(inspectedSource, /Get-DescendantClosure/);
  assert.match(inspectedSource, /Get-CurrentOwnedClosureFacts/);
  assert.match(inspectedSource, /\$depthByPid/);
  assert.match(inspectedSource, /creationTime100ns/);
  assert.match(inspectedSource, /nativeImagePath/);
  assert.match(inspectedSource, /Stop-Process -Id/);
  assert.match(inspectedSource, /unknown non-CEF descendant executable/);
  assert.match(inspectedSource, /Wry WebView2 descendant is not a valid Microsoft runtime/);
  assert.doesNotMatch(inspectedSource, /icacls|shell\s*=\s*true/iu);
  assert.match(evidenceSource, /Assert-NoReparseAncestors \$root/);
  assert.match(evidenceSource, /evidence root ancestor contains a reparse point/);
  assert.match(evidenceSource, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(evidenceSource, /Set-Acl -LiteralPath \$root/);
  assert.match(seedSource, /Assert-NoReparseAncestors \$smokeRoot/);
  assert.match(seedSource, /install root already exists/);
  assert.match(seedSource, /icacls\.exe/);
  assert.match(seedSource, /:\(OI\)\(CI\)\(M\)/);
  assert.match(seedSource, /\/grant \$grant \/L \/Q/);
  assert.doesNotMatch(seedSource, /shell\s*=\s*true/iu);
  assert.deepEqual(
    validateWindowsEvidenceRootAclObservation(fixtureEvidenceAcl(plan), plan),
    fixtureEvidenceAcl(plan),
  );
  assert.deepEqual(
    validateWindowsUpgradeAclSeedObservation(fixtureUpgradeAclSeed(plan), plan),
    fixtureUpgradeAclSeed(plan),
  );
});

test('injected runner observes live children before ACK and writes validated attestation last', async () => {
  const plan = fixturePlan();
  const preflight = fixturePreflight(plan);
  const checkpoint = fixtureCheckpoint(plan);
  const receipt = fixtureReceipt(plan, checkpoint);
  const observation = fixtureObservation(plan);
  const events = [];
  let writtenAttestation;
  const result = await executeWindowsMode2ProductionSmoke({ plan, manifestIdentity, environment }, {
    prepareRoots: async () => { events.push('prepare'); },
    protectEvidenceRoot: async () => { events.push('protect'); return fixtureEvidenceAcl(plan); },
    seedUpgradeAcl: async () => { events.push('seed'); return fixtureUpgradeAclSeed(plan); },
    install: async () => { events.push('install'); },
    inspectPreflight: async () => { events.push('preflight'); return preflight; },
    launch: async () => { events.push('launch'); return { pid: 4242 }; },
    waitForJson: async (candidate) => {
      if (candidate === plan.paths.observationPath) { events.push('checkpoint'); return checkpoint; }
      events.push('receipt'); return receipt;
    },
    observeProcesses: async () => { events.push('observe'); return observation; },
    writeJson: async (candidate, value) => {
      events.push('ack');
      assert.equal(candidate, plan.paths.ackPath);
      assert.deepEqual(value, createObservationAck(plan, checkpoint));
    },
    waitForExit: async () => { events.push('exit'); return { code: 0, signal: null }; },
    inspectCleanup: async () => { events.push('cleanup'); return fixtureCleanedProcesses(); },
    terminate: async () => { throw new Error('unexpected termination'); },
    writeAttestation: async (candidate, value) => {
      events.push('attestation');
      writtenAttestation = value;
      assert.equal(candidate, plan.paths.attestationPath);
      return { sha256: createHash('sha256')
        .update(`${JSON.stringify(writtenAttestation, null, 2)}\n`)
        .digest('hex') };
    },
  });
  assert.deepEqual(events, ['prepare', 'protect', 'seed', 'install', 'preflight', 'launch', 'checkpoint', 'observe', 'ack', 'receipt', 'exit', 'cleanup', 'attestation']);
  assert.equal(result.status, 'attested');
  assert.deepEqual(writtenAttestation, result.attestation);
  assert.equal(result.attestation.runtime.receiptSha256, hashWindowsMode2SmokeJson(receipt));
  assert.deepEqual(result.attestation.runtime.window, fixtureWindow());
  assert.equal(result.summary.nativeWindowVerified, true);
  assert.equal(result.summary.processTokenSandboxVerified, true);
  assert.equal(result.summary.upgradeAclNarrowed, true);
  assert.equal(result.summary.attestationSha256, createHash('sha256')
    .update(`${JSON.stringify(writtenAttestation, null, 2)}\n`)
    .digest('hex'));
  assert.equal(Object.hasOwn(writtenAttestation, 'attestationSha256'), false);
});

test('runner refuses unsandboxed live evidence, terminates the owned app, and emits no attestation', async () => {
  const plan = fixturePlan();
  const checkpoint = fixtureCheckpoint(plan);
  const observation = fixtureObservation(plan);
  observation.processes[1] = {
    ...observation.processes[1],
    commandLine: `${observation.processes[1].commandLine} "--no-sandbox"`,
  };
  let terminated = false;
  let attested = false;
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({ plan, manifestIdentity, environment }, {
    prepareRoots: async () => {},
    protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => fixtureUpgradeAclSeed(plan),
    install: async () => {},
    inspectPreflight: async () => fixturePreflight(plan),
    launch: async () => ({ pid: 4242 }),
    waitForJson: async () => checkpoint,
    observeProcesses: async () => observation,
    terminate: async () => { terminated = true; return fixtureCleanedProcesses(); },
    writeAttestation: async () => { attested = true; },
  }), /unsandboxed command line/);
  assert.equal(terminated, true);
  assert.equal(attested, false);
});

test('runner rejects stale HWND evidence and fake shared-state or token-only sandbox claims', async () => {
  const plan = fixturePlan();
  const checkpoint = fixtureCheckpoint(plan);
  const staleWindow = fixtureObservation(plan);
  staleWindow.window = { ...staleWindow.window, visible: false };
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({
    plan,
    manifestIdentity,
    environment,
  }, {
    prepareRoots: async () => {},
    protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => fixtureUpgradeAclSeed(plan),
    install: async () => {},
    inspectPreflight: async () => fixturePreflight(plan),
    launch: async () => ({ pid: 4242 }),
    waitForJson: async () => checkpoint,
    observeProcesses: async () => staleWindow,
    terminate: async () => fixtureCleanedProcesses(),
  }), /not actually visible/);

  const weakRenderer = fixtureObservation(plan);
  weakRenderer.processes[1] = {
    ...weakRenderer.processes[1],
    token: {
      ...weakRenderer.processes[1].token,
      integritySid: 'S-1-16-4096',
      integrityRid: 4096,
      isRestricted: false,
    },
  };
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({
    plan,
    manifestIdentity,
    environment,
  }, {
    prepareRoots: async () => {},
    protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => fixtureUpgradeAclSeed(plan),
    install: async () => {},
    inspectPreflight: async () => fixturePreflight(plan),
    launch: async () => ({ pid: 4242 }),
    waitForJson: async () => checkpoint,
    observeProcesses: async () => weakRenderer,
    terminate: async () => fixtureCleanedProcesses(),
  }), /restricted Untrusted token/);
});

test('process evidence is bound to a stable native PID, image and creation time', () => {
  const plan = fixturePlan();
  const receipt = fixtureCheckpoint(plan);
  const closure = fixtureObservation(plan).processClosure;
  const expected = {
    installedExecutablePath: plan.paths.installedExecutablePath,
    installedExecutableSha256: EXECUTABLE_SHA,
  };

  const swappedPid = fixtureProcesses(plan);
  swappedPid[1] = { ...swappedPid[1], nativePid: 9001 };
  assert.throws(
    () => validateWindowsProcessSandboxEvidence(closure, swappedPid, receipt, expected),
    /native handle PID mismatch/,
  );

  const detachedImage = fixtureProcesses(plan);
  detachedImage[1] = {
    ...detachedImage[1],
    nativeImagePath: 'D:\\a\\_temp\\replacement\\ccem-desktop.exe',
  };
  assert.throws(
    () => validateWindowsProcessSandboxEvidence(closure, detachedImage, receipt, expected),
    /does not match its stable descendant-closure identity/,
  );

  const staleChild = fixtureProcesses(plan);
  staleChild[1] = { ...staleChild[1], creationTime100ns: '133799999999999999' };
  assert.throws(
    () => validateWindowsProcessSandboxEvidence(closure, staleChild, receipt, expected),
    /does not match its stable descendant-closure identity/,
  );
});

test('preflight and evidence ACL proofs fail closed on ancestor, tree, or DACL drift', () => {
  const plan = fixturePlan();

  const reparseAncestor = fixturePreflight(plan);
  reparseAncestor.installedTreeSafety.ancestorReparseFree = false;
  assert.throws(
    () => validatePreflightObservation(reparseAncestor, plan, manifestIdentity),
    /plain safe no-follow tree/,
  );

  const incompleteAcl = fixturePreflight(plan);
  incompleteAcl.lpacAcl.verifiedFiles.pop();
  incompleteAcl.lpacAcl.verifiedFileCount -= 1;
  incompleteAcl.lpacAcl.verifiedPathCount -= 1;
  assert.throws(
    () => validatePreflightObservation(incompleteAcl, plan, manifestIdentity),
    /does not cover the exact installed tree/,
  );

  const inheritedEvidenceRoot = {
    ...fixtureEvidenceAcl(plan),
    inheritanceProtected: false,
  };
  assert.throws(
    () => validateWindowsEvidenceRootAclObservation(inheritedEvidenceRoot, plan),
    /not protected for only the runner owner and SYSTEM/,
  );
});

test('checkpoint rejects a native child HWND owned by another process', async () => {
  const plan = fixturePlan();
  const checkpoint = fixtureCheckpoint(plan);
  checkpoint.productionPath.nativeWindow = {
    ...checkpoint.productionPath.nativeWindow,
    ownerPid: 7777,
  };
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({
    plan,
    manifestIdentity,
    environment,
  }, {
    prepareRoots: async () => {},
    protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => fixtureUpgradeAclSeed(plan),
    install: async () => {},
    inspectPreflight: async () => fixturePreflight(plan),
    launch: async () => ({ pid: 4242 }),
    waitForJson: async () => checkpoint,
    terminate: async () => fixtureCleanedProcesses(),
  }), /not owned by the launched browser process/);
});

test('checkpoint and receipt reject a fake production path or incomplete cleanup', async () => {
  const plan = fixturePlan();
  const escaped = fixtureCheckpoint(plan);
  escaped.productionPath.profileStateRoot = 'D:\\Users\\runneradmin\\.ccem\\browser\\login\\profile-state';
  const receipt = fixtureReceipt(plan, fixtureCheckpoint(plan));
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({
    plan,
    manifestIdentity,
    environment,
  }, {
    prepareRoots: async () => {},
    protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => fixtureUpgradeAclSeed(plan),
    install: async () => {},
    inspectPreflight: async () => fixturePreflight(plan),
    launch: async () => ({ pid: 4242 }),
    waitForJson: async () => escaped,
    terminate: async () => fixtureCleanedProcesses(),
  }), /profileStateRoot escaped the current run/);

  const checkpoint = fixtureCheckpoint(plan);
  receipt.productionPath.cleanup.ownerRecordCount = 1;
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({
    plan,
    manifestIdentity,
    environment,
  }, {
    prepareRoots: async () => {},
    protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => fixtureUpgradeAclSeed(plan),
    install: async () => {},
    inspectPreflight: async () => fixturePreflight(plan),
    launch: async () => ({ pid: 4242 }),
    waitForJson: async (candidate) => candidate === plan.paths.observationPath ? checkpoint : receipt,
    observeProcesses: async () => fixtureObservation(plan),
    writeJson: async () => {},
    waitForExit: async () => ({ code: 0, signal: null }),
    inspectCleanup: async () => fixtureCleanedProcesses(),
    terminate: async () => fixtureCleanedProcesses(),
  }), /profile, owner, and session cleanup/);

  const semanticReceipt = fixtureReceipt(plan, checkpoint);
  semanticReceipt.productionPath.semantic.postPauseWriteDenied = false;
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({
    plan, manifestIdentity, environment,
  }, {
    prepareRoots: async () => {}, protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => fixtureUpgradeAclSeed(plan), install: async () => {},
    inspectPreflight: async () => fixturePreflight(plan), launch: async () => ({ pid: 4242 }),
    waitForJson: async (candidate) => candidate === plan.paths.observationPath ? checkpoint : semanticReceipt,
    observeProcesses: async () => fixtureObservation(plan), writeJson: async () => {},
    waitForExit: async () => ({ code: 0, signal: null }),
    inspectCleanup: async () => ({ remainingOwnedPids: [], remainingClosurePids: [] }), terminate: async () => {},
  }), /capability read\/write and post-pause revocation/);
});

test('runner refuses an unbound upgrade ACL seed before installation', async () => {
  const plan = fixturePlan();
  const seed = { ...fixtureUpgradeAclSeed(plan), writeGranted: false };
  let installed = false;
  let terminated = false;
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({
    plan,
    manifestIdentity,
    environment,
  }, {
    prepareRoots: async () => {},
    protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => seed,
    install: async () => { installed = true; },
    terminate: async () => { terminated = true; return fixtureCleanedProcesses(); },
  }), /not the exact current-run inherited Modify grant/);
  assert.equal(installed, false);
  assert.equal(terminated, true);
});

test('runner cleans the isolated executable path when installation fails before launch', async () => {
  const plan = fixturePlan();
  let launched = false;
  let terminated = false;
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({
    plan,
    manifestIdentity,
    environment,
  }, {
    prepareRoots: async () => {},
    protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => fixtureUpgradeAclSeed(plan),
    install: async () => { throw new Error('installer failed'); },
    launch: async () => { launched = true; },
    terminate: async (receivedPlan, tracked, processClosure) => {
      assert.equal(receivedPlan, plan);
      assert.equal(tracked, undefined);
      assert.deepEqual(processClosure, []);
      terminated = true;
      return fixtureCleanedProcesses();
    },
  }), /installer failed/);
  assert.equal(launched, false);
  assert.equal(terminated, true);
});

test('failure cleanup rejects a nonzero exact owned or descendant residue report', async () => {
  const plan = fixturePlan();
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({
    plan,
    manifestIdentity,
    environment,
  }, {
    prepareRoots: async () => {},
    protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => fixtureUpgradeAclSeed(plan),
    install: async () => { throw new Error('installer failed before observation'); },
    terminate: async (_plan, launched, processClosure) => {
      assert.equal(launched, undefined);
      assert.deepEqual(processClosure, []);
      return { remainingOwnedPids: [], remainingClosurePids: [4246] };
    },
  }), /installer failed before observation; owned-process termination also failed: termination left owned PIDs \[\] or closure PIDs \[4246\]/);
});

test('root-exited-before-observation cleanup anchors only current signed CEF or Wry descendants', async () => {
  const plan = fixturePlan();
  const launched = {
    pid: 4242,
    notBeforeCreationTime100ns: '133800000000000000',
    stderr: () => '',
  };
  let terminationCommand;
  await assert.rejects(() => executeWindowsMode2ProductionSmoke({
    plan, manifestIdentity, environment,
  }, {
    prepareRoots: async () => {}, protectEvidenceRoot: async () => fixtureEvidenceAcl(plan),
    seedUpgradeAcl: async () => fixtureUpgradeAclSeed(plan), install: async () => {},
    inspectPreflight: async () => fixturePreflight(plan), launch: async () => launched,
    waitForJson: async () => { throw new Error('browser root exited before observation'); },
    terminate: async (receivedPlan, receivedLaunch, processClosure) => {
      assert.equal(receivedLaunch, launched);
      assert.deepEqual(processClosure, []);
      terminationCommand = createWindowsOwnedProcessCommand(
        receivedPlan, 'terminate', processClosure, receivedLaunch,
      );
      return fixtureCleanedProcesses();
    },
  }), /browser root exited before observation/);

  const source = Buffer.from(terminationCommand.args[3], 'base64').toString('utf16le');
  const configBase64 = source.match(/FromBase64String\('([^']+)'\)/u)?.[1];
  const config = JSON.parse(Buffer.from(configBase64, 'base64').toString('utf8'));
  assert.equal(config.virtualRootPid, launched.pid);
  assert.equal(
    config.virtualRootNotBeforeCreationTime100ns,
    launched.notBeforeCreationTime100ns,
  );
  assert.match(source, /ParentProcessId -ne \$virtualRootPid/);
  assert.match(source, /virtual root PID was reused by a foreign executable/);
  assert.match(source, /virtual root identity predates this launch/);
  assert.match(source, /Get-TrustedRuntimeClassification/);
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /Microsoft Corporation/);
  assert.match(source, /virtual-root descendant predates this launch/);
  assert.throws(
    () => createWindowsOwnedProcessCommand(plan, 'terminate', [], { pid: 4242 }),
    /virtual root identity is invalid/,
  );
});
