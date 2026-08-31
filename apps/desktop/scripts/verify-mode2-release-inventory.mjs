import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CEF_FULL_VERSION,
  FRAMEWORK_ATTESTED_PATH,
  FRAMEWORK_NESTED_CODE_RELATIVES,
  FRAMEWORK_NAME,
  HELPER_SPECS,
  SIGNING_ATTESTATION_NAME,
  SIGNING_ATTESTATION_VERIFICATION,
  STAGE_MANIFEST_NAME,
  digestStage,
} from './stage-cef-macos.mjs';
import {
  validateMacReleaseSigning,
  validateWindowsReleaseSigning,
} from './validate-release-signing-config.mjs';
import {
  WINDOWS_MAIN_EXECUTABLE_NAME,
  WINDOWS_SANDBOX_CLIENT_NAME,
} from './stage-cef-windows.mjs';
import { verifyTauriUpdaterSignature } from './verify-tauri-updater-signature.mjs';
import { macReleaseFileFingerprint } from './macos-macho-integrity.mjs';
import {
  cefArchiveSpec,
  inspectStagedCefLegalFiles,
} from './cef-runtime-contract.mjs';
import { compareMacCefFrameworkTrees } from './macos-cef-bundle-contract.mjs';
import { inspectMacosSafeStorageReleaseAttestation } from './verify-macos-safe-storage-release.mjs';
import {
  validateCefMacosSafeStorageBrandingEvidence,
  verifyCefMacosSafeStorageBranding,
} from './cef-macos-safe-storage-branding.mjs';
import { canonicalPeFileSha256 } from './windows-pe-contract.mjs';
import {
  authenticodeInspectionCommand,
  createWindowsVerificationPlan,
} from './windows-release-verification-plan.mjs';
import {
  createWindowsRuntimeInventoryFingerprint,
  expectedWindowsMode2InstallRoot,
  expectedWindowsMode2SmokeRoot,
  validateWindowsInstalledTreeInventory,
  validateWindowsMode2ProductionSmokeAttestation,
} from './windows-mode2-production-smoke-contract.mjs';
import {
  CODESIGN_PATH,
  SPCTL_PATH,
  XCRUN_PATH,
  assertNotaryAccepted,
  createDmgNotarizationPlan,
  createMacAppTrustPlan,
  createMacVerificationPlan,
} from './verify-mode2-release-inventory-macos.mjs';
import {
  RELEASE_INVENTORY_SCHEMA_VERSION,
  fail,
  readJson,
  readJsonWithSha256,
  requireDirectory,
  requireFile,
  sameJson,
  sha256,
  validateInventoryFileBindings,
  validateInventorySetWithPolicy,
  validateSourceCommit,
} from './verify-mode2-release-inventory-shared.mjs';
import {
  createWindowsAuthenticodeCandidatePaths,
  inspectWindowsLocaleInventory,
  inspectWindowsTree,
  validateWindowsAuthenticodeResults,
} from './verify-mode2-release-inventory-windows.mjs';

export { createWindowsVerificationPlan } from './windows-release-verification-plan.mjs';
export {
  CODESIGN_PATH,
  SPCTL_PATH,
  XCRUN_PATH,
  assertNotaryAccepted,
  createDmgNotarizationPlan,
  createMacAppTrustPlan,
  createMacVerificationPlan,
} from './verify-mode2-release-inventory-macos.mjs';
export {
  RELEASE_INVENTORY_SCHEMA_VERSION,
  validateInventoryFileBindings,
} from './verify-mode2-release-inventory-shared.mjs';
export {
  createWindowsAuthenticodeCandidatePaths,
  inspectWindowsLocaleInventory,
  inspectWindowsTree,
  validateWindowsAuthenticodeResults,
} from './verify-mode2-release-inventory-windows.mjs';

export const HDIUTIL_PATH = '/usr/bin/hdiutil';
export const TAR_PATH = '/usr/bin/tar';
export const WINDOWS_MODE2_RELEASE_BLOCK_REASON = [
  'Windows Mode 2 release is fail-closed until an authorized signed-runner production smoke',
  'attests direct CDP plus production-manager Ready, shown/hidden/reshown, handoff/pause/takeover,',
  'release/reopen/profile-owner-session cleanup, same-executable CEF children, no --no-sandbox,',
  'and the final runtime directory LPAC ACL *S-1-15-2-2:(OI)(CI)(RX)',
].join(' ');

const scriptPath = fileURLToPath(import.meta.url);

export function assertWindowsMode2ProductionSmokeAttested(attestation, expected) {
  // Producer provenance, PE integrity, and Authenticode prove the artifact
  // shape. They do not prove that the signed production app actually reaches
  // Ready with sandboxed same-executable subprocesses or that the installed
  // runtime directory has Chromium's required LPAC read/execute ACL. Keep
  // release delivery blocked until the Windows signed runner emits and this
  // verifier consumes that runtime attestation.
  if (!attestation || !expected) fail(WINDOWS_MODE2_RELEASE_BLOCK_REASON);
  return validateWindowsMode2ProductionSmokeAttestation(attestation, expected);
}

async function artifactMetadata(candidate) {
  await requireFile(candidate, 'release artifact');
  const stat = await fsp.stat(candidate);
  return {
    fileName: path.basename(candidate),
    sha256: await sha256(candidate),
    size: stat.size,
  };
}

export async function bindFinalDmgArtifact(inventory, dmgPath) {
  inventory.artifacts.dmg = await artifactMetadata(dmgPath);
  return inventory.artifacts.dmg;
}

function xmlDecode(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function plistString(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<string>([^<]*)</string>`));
  return match ? xmlDecode(match[1]) : null;
}

async function validatePlist(candidate, expected) {
  await requireFile(candidate, 'Info.plist');
  const source = await fsp.readFile(candidate, 'utf8');
  for (const [key, value] of Object.entries(expected)) {
    if (plistString(source, key) !== value) {
      fail(`${candidate} ${key} does not equal ${value}`);
    }
  }
}

export async function inspectMacApp({ appDir, stageDir, target, version, sourceCommit, signing }) {
  await requireDirectory(appDir, 'macOS app');
  const contents = path.join(appDir, 'Contents');
  const frameworks = path.join(contents, 'Frameworks');
  const stageManifest = await readJson(path.join(stageDir, STAGE_MANIFEST_NAME), 'CEF stage manifest');
  const attestation = await readJson(
    path.join(stageDir, SIGNING_ATTESTATION_NAME),
    'CEF signing attestation',
  );
  if (
    stageManifest.schemaVersion !== 1
    || stageManifest.cef?.runtimeVersion !== CEF_FULL_VERSION
    || !sameJson(stageManifest.cef?.archive, {
      type: cefArchiveSpec(target).type,
      name: cefArchiveSpec(target).name,
      sha1: cefArchiveSpec(target).sha1,
    })
    || stageManifest.build?.target !== target
    || stageManifest.build?.profile !== 'release'
    || stageManifest.cef?.sourceFrameworkPinned !== true
    || stageManifest.cef?.sourceFrameworkExecutableSha256
      !== cefArchiveSpec(target).frameworkExecutableSha256
    || stageManifest.cef?.sourceFrameworkTreeSha256
      !== cefArchiveSpec(target).frameworkTreeSha256
    || stageManifest.cef?.brandedFrameworkTreeSha256
      !== cefArchiveSpec(target).brandedFrameworkTreeSha256
    || stageManifest.cef?.safeStorageBranding?.sourceExecutableSha256
      !== cefArchiveSpec(target).frameworkExecutableSha256
    || stageManifest.cef?.safeStorageBranding?.brandedExecutableSha256
      !== cefArchiveSpec(target).brandedFrameworkExecutableSha256
    || stageManifest.cef?.safeStorageBranding?.byteOffset
      !== cefArchiveSpec(target).safeStorageByteOffset
  ) {
    fail(`CEF stage does not prove ${CEF_FULL_VERSION} for ${target}/release`);
  }
  const stageLegal = await inspectStagedCefLegalFiles(stageDir, target, stageManifest.legal);
  if (
    attestation.schemaVersion !== 3
    || attestation.verification !== SIGNING_ATTESTATION_VERIFICATION
    || attestation.target !== target
    || attestation.profile !== 'release'
    || attestation.sourceCommit !== sourceCommit
    || attestation.identity !== signing?.identity
    || attestation.teamId !== signing?.teamId
    || attestation.cefRuntimeVersion !== CEF_FULL_VERSION
    || attestation.stageDigest !== await digestStage(stageDir)
  ) {
    fail('CEF signing attestation does not cover the current pinned stage');
  }
  const requiredBundlePaths = [
    FRAMEWORK_ATTESTED_PATH,
    ...HELPER_SPECS.map(({ bundleName }) => `Frameworks/${bundleName}`),
  ];
  if (
    !Array.isArray(attestation.verifiedBundlePaths)
    || !sameJson([...attestation.verifiedBundlePaths].sort(), [...requiredBundlePaths].sort())
  ) {
    fail('CEF signing attestation must cover exactly the framework and every Helper.app');
  }
  if (
    attestation.verifiedFramework?.bundleIdentifier !== 'org.cef.framework'
    || attestation.verifiedFramework?.bundlePath !== FRAMEWORK_ATTESTED_PATH
    || attestation.verifiedFramework?.hardenedRuntime !== true
    || !sameJson(
      attestation.verifiedFramework?.nestedCodePaths,
      FRAMEWORK_NESTED_CODE_RELATIVES.map(
        (relative) => `${FRAMEWORK_ATTESTED_PATH}/${relative}`,
      ),
    )
    || !sameJson(attestation.verifiedFramework?.entitlements, [])
  ) {
    fail('CEF signing attestation does not cover the pinned framework nested code');
  }

  const appInfoPlist = path.join(contents, 'Info.plist');
  await validatePlist(appInfoPlist, {
    CFBundleIdentifier: 'com.ccem.desktop',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
  });
  const appInfoSource = await fsp.readFile(appInfoPlist, 'utf8');
  const mainExecutableName = plistString(appInfoSource, 'CFBundleExecutable');
  if (!mainExecutableName || path.basename(mainExecutableName) !== mainExecutableName) {
    fail('macOS app CFBundleExecutable must be an exact basename');
  }
  const mainExecutable = path.join(contents, 'MacOS', mainExecutableName);
  await requireFile(mainExecutable, 'macOS main executable');
  const framework = path.join(frameworks, FRAMEWORK_NAME);
  await requireDirectory(framework, 'bundled CEF framework');
  const stageFramework = path.join(stageDir, FRAMEWORK_NAME);
  const safeStorageBranding = validateCefMacosSafeStorageBrandingEvidence(
    stageManifest.cef?.safeStorageBranding,
  );
  await verifyCefMacosSafeStorageBranding(
    path.join(stageFramework, 'Chromium Embedded Framework'),
    safeStorageBranding,
    { allowSignedExecutable: true },
  );
  const bundledFrameworkExecutable = path.join(framework, 'Chromium Embedded Framework');
  await verifyCefMacosSafeStorageBranding(
    bundledFrameworkExecutable,
    safeStorageBranding,
    { allowSignedExecutable: true },
  );
  const bundledResourceFingerprint = await compareMacCefFrameworkTrees({
    stageFramework,
    bundledFramework: framework,
    target,
  });
  const bundledLegal = await inspectStagedCefLegalFiles(
    path.join(contents, 'Resources'),
    target,
    stageLegal,
  );

  const actualHelpers = (await fsp.readdir(frameworks))
    .filter((entry) => /^ccem-desktop Helper(?: \(.+\))?\.app$/.test(entry))
    .sort();
  const expectedHelpers = HELPER_SPECS.map(({ bundleName }) => bundleName).sort();
  if (!sameJson(actualHelpers, expectedHelpers)) {
    fail(`bundled Helper.app inventory mismatch: ${actualHelpers.join(', ')}`);
  }
  const helperExecutableHashes = {};
  for (const spec of HELPER_SPECS) {
    const helperBundle = path.join(frameworks, spec.bundleName);
    await requireDirectory(helperBundle, `${spec.bundleName} bundle`);
    const helper = path.join(helperBundle, 'Contents');
    await validatePlist(path.join(helper, 'Info.plist'), {
      CFBundleExecutable: spec.executableName,
      CFBundleIdentifier: spec.bundleIdentifier,
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
    });
    const bundledExecutable = path.join(helper, 'MacOS', spec.executableName);
    const stagedExecutable = path.join(
      stageDir,
      spec.bundleName,
      'Contents',
      'MacOS',
      spec.executableName,
    );
    await requireFile(bundledExecutable, `${spec.bundleName} executable`);
    await requireFile(stagedExecutable, `staged ${spec.bundleName} executable`);
    const bundledHash = await macReleaseFileFingerprint(bundledExecutable, { requireMachO: true });
    if (bundledHash !== await macReleaseFileFingerprint(stagedExecutable, { requireMachO: true })) {
      fail(`${spec.bundleName} executable differs from the signed pinned stage`);
    }
    helperExecutableHashes[spec.bundleName] = bundledHash;
  }

  return {
    schemaVersion: RELEASE_INVENTORY_SCHEMA_VERSION,
    platform: target,
    appVersion: version,
    sourceCommit,
    mode2Included: true,
    cefRuntimeVersion: CEF_FULL_VERSION,
    cefSafeStorageBranding: {
      ...safeStorageBranding,
      signedExecutableSha256: await sha256(bundledFrameworkExecutable),
    },
    mainExecutable: {
      fileName: mainExecutableName,
      sha256: await sha256(mainExecutable),
      size: (await fsp.stat(mainExecutable)).size,
    },
    helperBundles: expectedHelpers,
    helperExecutableHashes,
    stableCefResources: bundledResourceFingerprint,
    cefLegal: bundledLegal,
  };
}

async function locateSingleApp(root) {
  const matches = [];
  async function visit(directory, depth) {
    if (depth > 5) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.name === 'CCEM Desktop.app') matches.push(candidate);
      else await visit(candidate, depth + 1);
    }
  }
  await visit(root, 0);
  if (matches.length !== 1) fail(`expected exactly one CCEM Desktop.app in ${root}; found ${matches.length}`);
  return matches[0];
}

function runCommandResult(command, options = {}) {
  const result = spawnSync(command.program, command.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) fail(`cannot execute ${command.program}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command.program} ${command.args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    combined: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

function runCommand(command, options = {}) {
  return runCommandResult(command, options).combined;
}

function assertMacCiAuthorization() {
  if (
    process.env.GITHUB_ACTIONS !== 'true'
    || process.env.RUNNER_OS !== 'macOS'
    || process.env.CCEM_RELEASE_ALLOW_PLATFORM_VERIFICATION !== '1'
    || process.platform !== 'darwin'
  ) {
    fail('macOS platform verification is allowed only on an explicitly authorized GitHub Actions macOS runner');
  }
}

function validateMainMacSignature(output, signing) {
  const teamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  if (teamId !== signing.teamId || authorities[0] !== signing.identity) {
    fail('final macOS app signature does not match the pinned Developer ID identity');
  }
}

async function resolveNotaryApiKeyPath(environment = process.env) {
  const configured = environment.CCEM_NOTARY_API_KEY_PATH;
  const runnerTemp = environment.RUNNER_TEMP;
  if (!configured || !runnerTemp || !path.isAbsolute(configured)) {
    fail('CCEM_NOTARY_API_KEY_PATH must be an absolute current-run RUNNER_TEMP path');
  }
  const relative = path.relative(path.resolve(runnerTemp), path.resolve(configured));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('CCEM_NOTARY_API_KEY_PATH must stay inside current-run RUNNER_TEMP');
  }
  await requireFile(configured, 'App Store Connect API private key');
  const mode = (await fsp.stat(configured)).mode & 0o777;
  if ((mode & 0o077) !== 0) fail('App Store Connect API private key must not be group/world accessible');
  return path.resolve(configured);
}

function verifyMacTrustPlan(appDir, signing) {
  for (const command of createMacAppTrustPlan(appDir)) {
    const output = runCommand(command);
    if (command.program === CODESIGN_PATH && command.args[0] === '--display') {
      validateMainMacSignature(output, signing);
    }
  }
}

async function extractTarGz(archive, output) {
  await fsp.mkdir(output, { recursive: true });
  runCommand({ program: TAR_PATH, args: ['-xzf', archive, '-C', output, '--no-same-owner'] });
}

async function mountDmg(dmgPath, mountPoint) {
  await fsp.mkdir(mountPoint, { recursive: true });
  runCommand({
    program: HDIUTIL_PATH,
    args: ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath],
  });
}

function unmountDmg(mountPoint) {
  runCommand({ program: HDIUTIL_PATH, args: ['detach', mountPoint] });
}

async function inspectMacRelease(options, dryRun) {
  const signing = validateMacReleaseSigning();
  const appInventory = await inspectMacApp({ ...options, signing });
  const safeStorageRuntimeAttestation = await inspectMacosSafeStorageReleaseAttestation({
    attestationPath: options.safeStorageAttestationPath,
    appDir: options.appDir,
    target: options.target,
    appVersion: options.version,
    sourceCommit: options.sourceCommit,
    executableSha256: appInventory.mainExecutable.sha256,
    frameworkSha256: appInventory.cefSafeStorageBranding.signedExecutableSha256,
  });
  await requireFile(options.dmgPath, 'DMG');
  await requireFile(options.updaterPath, 'macOS updater archive');
  const updaterSignaturePath = `${options.updaterPath}.sig`;
  await requireFile(updaterSignaturePath, 'macOS updater signature');
  const updaterSignature = await verifyTauriUpdaterSignature({
    artifactPath: options.updaterPath,
    signaturePath: updaterSignaturePath,
  });
  const inventory = {
    ...appInventory,
    macosSafeStorageRuntimeAttestation: safeStorageRuntimeAttestation,
    updaterSignatureVerification: updaterSignature.algorithm,
    artifacts: {
      dmg: await artifactMetadata(options.dmgPath),
      updater: await artifactMetadata(options.updaterPath),
      updaterSignature: await artifactMetadata(updaterSignaturePath),
    },
  };
  const keyPath = dryRun
    ? (process.env.CCEM_NOTARY_API_KEY_PATH || '<current-run-notary-api-key>')
    : await resolveNotaryApiKeyPath();
  const plan = {
    notarizeDmg: createDmgNotarizationPlan({
      dmgPath: options.dmgPath,
      keyPath,
      keyId: signing.dmgNotarization.keyId,
      issuer: signing.dmgNotarization.issuer,
    }),
    verifyRelease: createMacVerificationPlan(options),
  };
  if (dryRun) return { inventory, plan };

  assertMacCiAuthorization();
  const notaryResult = assertNotaryAccepted(runCommandResult(plan.notarizeDmg[0]).stdout);
  runCommand(plan.notarizeDmg[1]);
  for (const command of plan.verifyRelease) {
    const output = runCommand(command);
    if (command.program === CODESIGN_PATH && command.args[0] === '--display') {
      validateMainMacSignature(output, signing);
    }
  }

  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-mode2-release-'));
  try {
    const updaterRoot = path.join(temporary, 'updater');
    await extractTarGz(options.updaterPath, updaterRoot);
    const updaterApp = await locateSingleApp(updaterRoot);
    const updaterInventory = await inspectMacApp({
      ...options,
      appDir: updaterApp,
      signing,
    });
    if (!sameJson(appInventory, updaterInventory)) fail('updater app contains a mixed CEF inventory');
    verifyMacTrustPlan(updaterApp, signing);

    const mountPoint = path.join(temporary, 'dmg');
    await mountDmg(options.dmgPath, mountPoint);
    try {
      const dmgApp = await locateSingleApp(mountPoint);
      const dmgInventory = await inspectMacApp({
        ...options,
        appDir: dmgApp,
        signing,
      });
      if (!sameJson(appInventory, dmgInventory)) fail('DMG contains a mixed CEF inventory');
      verifyMacTrustPlan(dmgApp, signing);
    } finally {
      unmountDmg(mountPoint);
    }
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
  // stapler mutates the DMG. Bind the inventory to the final stapled bytes,
  // not the pre-notarization artifact emitted by Tauri.
  await bindFinalDmgArtifact(inventory, options.dmgPath);
  inventory.platformVerification = 'macos-native-release-trust';
  inventory.dmgNotarization = { id: notaryResult.id, status: notaryResult.status };
  return { inventory, plan };
}
function assertWindowsCiAuthorization() {
  if (
    process.env.GITHUB_ACTIONS !== 'true'
    || process.env.RUNNER_OS !== 'Windows'
    || process.env.CCEM_RELEASE_ALLOW_PLATFORM_VERIFICATION !== '1'
    || process.platform !== 'win32'
  ) {
    fail('Windows platform verification is allowed only on an explicitly authorized GitHub Actions Windows runner');
  }
}

function parseJsonOutput(output, label) {
  try {
    const value = JSON.parse(output.trim());
    return Array.isArray(value) ? value : [value];
  } catch (error) {
    fail(`${label} did not return JSON: ${error.message}`);
  }
}

async function findWindowsInstallRoot(extracted) {
  const matches = [];
  async function visit(directory, depth) {
    if (depth > 8) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'ccem-desktop.exe')) {
      matches.push(directory);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path.join(directory, entry.name), depth + 1);
    }
  }
  await visit(extracted, 0);
  if (matches.length !== 1) fail(`expected one Windows install root; found ${matches.length}`);
  return matches[0];
}

async function inspectWindowsRelease(options, dryRun) {
  const signing = validateWindowsReleaseSigning();
  const root = options.stageDir;
  const appInventory = await inspectWindowsTree({
    root,
    version: options.version,
    sourceCommit: options.sourceCommit,
    requireApp: false,
    requireManifest: true,
  });
  await requireFile(options.appPath, 'Windows app executable');
  await requireFile(options.installerPath, 'Windows installer');
  await requireFile(options.updaterSignaturePath, 'Windows updater signature');
  const updaterSignature = await verifyTauriUpdaterSignature({
    artifactPath: options.installerPath,
    signaturePath: options.updaterSignaturePath,
  });
  const mainExecutable = await artifactMetadata(options.appPath);
  if (await canonicalPeFileSha256(options.appPath) !== appInventory.bootstrapCanonicalSha256) {
    fail('Windows main executable is not the signed form of the pinned official CEF bootstrap');
  }
  const inventory = {
    ...appInventory,
    updaterSignatureVerification: updaterSignature.algorithm,
    mainExecutable,
    artifacts: {
      updater: await artifactMetadata(options.installerPath),
      updaterSignature: await artifactMetadata(options.updaterSignaturePath),
    },
  };
  if (!options.windowsSmokeAttestationPath) fail(WINDOWS_MODE2_RELEASE_BLOCK_REASON);
  const attestationRecord = await readJsonWithSha256(
    options.windowsSmokeAttestationPath,
    'Windows Mode 2 production smoke attestation',
  );
  const attestation = attestationRecord.value;
  const installedRoot = expectedWindowsMode2InstallRoot(process.env);
  const smokeRoot = expectedWindowsMode2SmokeRoot(process.env);
  const installedExecutablePath = path.win32.join(installedRoot, WINDOWS_MAIN_EXECUTABLE_NAME);
  const runtimeFingerprint = createWindowsRuntimeInventoryFingerprint({
    installedExecutableSha256: mainExecutable.sha256,
    stableCefResources: appInventory.stableCefResources,
  });
  const installedTree = validateWindowsInstalledTreeInventory(
    attestation.installed?.installedTree,
    'Windows production smoke installed tree',
  );
  const smokeSummary = assertWindowsMode2ProductionSmokeAttested(attestation, {
    sourceCommit: options.sourceCommit,
    appVersion: options.version,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    repository: process.env.GITHUB_REPOSITORY,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    producerWorkflowRef: process.env.CCEM_MODE2_PRODUCER_WORKFLOW_REF,
    job: process.env.GITHUB_JOB,
    installedRoot,
    installedExecutablePath,
    installedExecutableSha256: mainExecutable.sha256,
    installerSha256: inventory.artifacts.updater.sha256,
    runtimeInventorySha256: runtimeFingerprint.sha256,
    verifiedPathCount: runtimeFingerprint.verifiedPathCount,
    runtimeRelativePaths: runtimeFingerprint.relativePaths,
    installedTreeInventorySha256: installedTree.inventorySha256,
    installedTreePathSetSha256: installedTree.pathSetSha256,
    installedTreePathCount: installedTree.pathCount,
    smokeRoot,
  });
  smokeSummary.attestationSha256 = attestationRecord.sha256;
  inventory.windowsRuntimeAttestation = smokeSummary;
  inventory.installedTree = installedTree;
  const plan = createWindowsVerificationPlan({
    appPath: options.appPath,
    sandboxClientPath: path.join(root, WINDOWS_SANDBOX_CLIENT_NAME),
    chromeElfPath: path.join(root, 'chrome_elf.dll'),
    installerPath: options.installerPath,
  });
  const builtAuthenticodePaths = createWindowsAuthenticodeCandidatePaths({
    runtimeRoot: root,
    mainExecutablePath: options.appPath,
    installerPath: options.installerPath,
  });
  plan.authenticode = authenticodeInspectionCommand(builtAuthenticodePaths);
  if (dryRun) return { inventory, plan };

  assertWindowsCiAuthorization();
  const authOutput = runCommand(plan.authenticode);
  validateWindowsAuthenticodeResults(
    parseJsonOutput(authOutput, 'Authenticode inspection'),
    signing,
    builtAuthenticodePaths,
    'built app, signed CEF resource, and installer',
  );
  const productVersion = runCommand(plan.cefVersion).trim();
  if (!productVersion.includes('150.0.7871.101')) {
    fail(`libcef.dll product version is not pinned Chromium 150.0.7871.101: ${productVersion}`);
  }
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-mode2-windows-'));
  try {
    runCommand({
      ...plan.extractInstaller,
      args: plan.extractInstaller.args.map((arg) => (
        arg === '-o<temporary-directory>' ? `-o${temporary}` : arg
      )),
    });
    const installRoot = await findWindowsInstallRoot(temporary);
    const installedInventory = await inspectWindowsTree({
      root: installRoot,
      version: options.version,
      sourceCommit: options.sourceCommit,
      requireManifest: true,
    });
    if (!sameJson(appInventory, installedInventory)) {
      fail('Windows installer contains a mixed CEF inventory');
    }
    const installedMain = path.join(installRoot, 'ccem-desktop.exe');
    if (await sha256(installedMain) !== mainExecutable.sha256) {
      fail('Windows installer main executable hash differs from the verified built executable');
    }
    const installedAuthenticodePaths = createWindowsAuthenticodeCandidatePaths({
      runtimeRoot: installRoot,
      mainExecutablePath: installedMain,
    });
    const installedAuthOutput = runCommand(authenticodeInspectionCommand(installedAuthenticodePaths));
    validateWindowsAuthenticodeResults(
      parseJsonOutput(installedAuthOutput, 'installed Authenticode inspection'),
      signing,
      installedAuthenticodePaths,
      'installed app and signed CEF resource',
    );
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
  inventory.platformVerification = 'windows-native-authenticode-installed-runtime-smoke';
  return { inventory, plan };
}

export function validateInventorySet(inventories, expectedVersion, expectedSourceCommit) {
  return validateInventorySetWithPolicy(
    inventories,
    expectedVersion,
    expectedSourceCommit,
    WINDOWS_MODE2_RELEASE_BLOCK_REASON,
  );
}
async function writeJsonAtomically(output, value) {
  const absolute = path.resolve(output);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, absolute);
}

function parseArgs(argv) {
  const options = { dryRun: false, inventoryFiles: [] };
  const valueOptions = new Map([
    ['--platform', 'platform'], ['--target', 'target'], ['--version', 'version'],
    ['--source-commit', 'sourceCommit'],
    ['--stage', 'stageDir'], ['--app', 'appDir'], ['--dmg', 'dmgPath'],
    ['--updater', 'updaterPath'], ['--installer', 'installerPath'],
    ['--updater-signature', 'updaterSignaturePath'], ['--output', 'output'],
    ['--windows-smoke-attestation', 'windowsSmokeAttestationPath'],
    ['--safe-storage-attestation', 'safeStorageAttestationPath'],
    ['--inventory', 'inventoryFiles'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--help') options.help = true;
    else if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      index += 1;
      const key = valueOptions.get(argument);
      if (key === 'inventoryFiles') options.inventoryFiles.push(path.resolve(value));
      else options[key] = ['version', 'platform', 'target', 'sourceCommit'].includes(key)
        ? value
        : path.resolve(value);
    } else fail(`unknown argument: ${argument}`);
  }
  return options;
}

function requiredOption(options, key) {
  if (!options[key]) fail(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node scripts/verify-mode2-release-inventory.mjs --platform <macos|windows|disabled|set> --version <version> --source-commit <sha> [artifact options] [--dry-run]\n');
    return { status: 'help' };
  }
  requiredOption(options, 'platform');
  requiredOption(options, 'version');
  requiredOption(options, 'sourceCommit');
  validateSourceCommit(options.sourceCommit);
  if (options.dryRun && options.output) fail('--dry-run cannot write --output');
  let result;
  if (options.platform === 'macos') {
    for (const key of [
      'target', 'stageDir', 'appDir', 'dmgPath', 'updaterPath',
      'safeStorageAttestationPath',
    ]) requiredOption(options, key);
    result = await inspectMacRelease(options, options.dryRun);
  } else if (options.platform === 'windows') {
    for (const key of ['stageDir', 'appDir', 'installerPath', 'updaterSignaturePath']) requiredOption(options, key);
    options.appPath = options.appDir;
    result = await inspectWindowsRelease(options, options.dryRun);
  } else if (options.platform === 'disabled') {
    requiredOption(options, 'target');
    if (!/^(aarch64|x86_64)-apple-darwin$/.test(options.target)) {
      fail('only unsigned macOS preview artifacts may disable Mode 2');
    }
    result = {
      inventory: {
        schemaVersion: RELEASE_INVENTORY_SCHEMA_VERSION,
        platform: options.target,
        appVersion: options.version,
        sourceCommit: options.sourceCommit,
        mode2Included: false,
        cefRuntimeVersion: null,
        helperBundles: [],
        stableCefResources: {},
        artifacts: {},
      },
      plan: [],
    };
  } else if (options.platform === 'set') {
    const inventories = await Promise.all(options.inventoryFiles.map((candidate) => readJson(candidate, 'release inventory')));
    validateInventoryFileBindings(options.inventoryFiles, inventories);
    result = {
      inventory: validateInventorySet(inventories, options.version, options.sourceCommit),
      plan: [],
    };
  } else {
    fail('--platform must be macos, windows, disabled, or set');
  }
  if (options.output) await writeJsonAtomically(options.output, result.inventory);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return { status: options.dryRun ? 'dry-run' : 'verified', ...result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
