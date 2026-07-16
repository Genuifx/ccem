import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CEF_FULL_VERSION,
  FRAMEWORK_NESTED_CODE_RELATIVES,
  FRAMEWORK_NAME,
  HELPER_SPECS,
  SIGNING_ATTESTATION_NAME,
  STAGE_MANIFEST_NAME,
  digestStage,
} from './stage-cef-macos.mjs';
import {
  CEF_LEGAL_DIRECTORY,
  cefArchiveSpec,
  cefDirectoryTreeSha256,
  inspectStagedCefLegalFiles,
} from './cef-runtime-contract.mjs';
import { verifyCefMacosSafeStorageBranding } from './cef-macos-safe-storage-branding.mjs';

export const CODESIGN_PATH = '/usr/bin/codesign';
export const SIGNING_VERIFICATION = 'strict-deep-external-v2';
export const CEF_FRAMEWORK_BUNDLE_IDENTIFIER = 'org.cef.framework';
export const CEF_FRAMEWORK_NESTED_CODE = FRAMEWORK_NESTED_CODE_RELATIVES;

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(scriptPath);
const desktopDir = path.resolve(scriptsDir, '..');
const tauriDir = path.join(desktopDir, 'src-tauri');
const defaultStageDir = path.join(tauriDir, 'target', 'cef-bundle', 'macos');
const jitEntitlementsPath = path.join(tauriDir, 'entitlements', 'cef-helper-jit.plist');

function fail(message) {
  throw new Error(`[cef-macos-sign] ${message}`);
}

function resolveSourceCommit(environment = process.env) {
  const sourceCommit = environment.GITHUB_SHA?.trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '')) {
    fail('GITHUB_SHA must be the exact source commit for CEF signing attestation');
  }
  return sourceCommit;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    stageDir: defaultStageDir,
    target: process.env.CCEM_CEF_TARGET_TRIPLE ?? null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (['--stage', '--target'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${arg} requires a value`);
      index += 1;
      if (arg === '--stage') options.stageDir = path.resolve(value);
      if (arg === '--target') options.target = value;
    } else if (arg === '--help') {
      options.help = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write('Usage: node scripts/sign-and-attest-cef-macos.mjs --target <triple> [--dry-run]\n\n');
  process.stdout.write('Actual signing requires GitHub Actions, macOS, and CCEM_CEF_ALLOW_CODESIGN=1.\n');
  process.stdout.write('--stage is accepted only with --dry-run for isolated fixture validation.\n');
}

async function pathType(candidate) {
  try {
    const stat = await fsp.lstat(candidate);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function requireDirectory(candidate, label) {
  const type = await pathType(candidate);
  if (type !== 'directory') fail(`${label} must be a real directory: ${candidate} (${type})`);
}

async function requireFile(candidate, label) {
  const type = await pathType(candidate);
  if (type !== 'file') fail(`${label} must be a regular file: ${candidate} (${type})`);
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

function expectedTopLevelNames() {
  return [
    FRAMEWORK_NAME,
    CEF_LEGAL_DIRECTORY.split('/')[0],
    ...HELPER_SPECS.map(({ bundleName }) => bundleName),
    STAGE_MANIFEST_NAME,
    SIGNING_ATTESTATION_NAME,
  ];
}

export async function validateStageForSigning(
  stageDir,
  target,
  { allowUnpinnedDryRun = false } = {},
) {
  if (!/^(aarch64|x86_64)-apple-darwin$/.test(target ?? '')) {
    fail(`unsupported or missing signed CEF target: ${target ?? 'none'}`);
  }
  await requireDirectory(stageDir, 'CEF stage');
  const entries = await fsp.readdir(stageDir);
  const allowed = new Set(expectedTopLevelNames());
  const unexpected = entries.filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0) fail(`CEF stage contains unexpected members: ${unexpected.join(', ')}`);

  const manifestPath = path.join(stageDir, STAGE_MANIFEST_NAME);
  await requireFile(manifestPath, 'CEF stage manifest');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.cef?.runtimeVersion !== CEF_FULL_VERSION) {
    fail(`stage does not contain the pinned CEF runtime ${CEF_FULL_VERSION}`);
  }
  const pinned = cefArchiveSpec(target);
  if (!allowUnpinnedDryRun && (
    manifest.cef?.sourceFrameworkPinned !== true
    || manifest.cef?.sourceFrameworkExecutableSha256 !== pinned.frameworkExecutableSha256
    || manifest.cef?.sourceFrameworkTreeSha256 !== pinned.frameworkTreeSha256
    || manifest.cef?.brandedFrameworkTreeSha256 !== pinned.brandedFrameworkTreeSha256
    || manifest.cef?.safeStorageBranding?.sourceExecutableSha256
      !== pinned.frameworkExecutableSha256
    || manifest.cef?.safeStorageBranding?.brandedExecutableSha256
      !== pinned.brandedFrameworkExecutableSha256
    || manifest.cef?.safeStorageBranding?.byteOffset !== pinned.safeStorageByteOffset
  )) {
    fail(`stage does not bind the official ${target} CEF framework derivation`);
  }
  if (manifest.build?.target !== target || manifest.build?.profile !== 'release') {
    fail(`stage build must exactly match ${target}/release`);
  }
  if (manifest.layout?.release !== 'bundled-only' || manifest.layout?.looseHelperIncluded !== false) {
    fail('signed release stage must use the bundled-only CEF layout');
  }
  if (manifest.tauriSigningCoverage?.helperAppsAutomaticallyAddedToSignPaths !== false) {
    fail('stage manifest must preserve the Tauri custom-files signing boundary');
  }
  await inspectStagedCefLegalFiles(stageDir, target, manifest.legal, {
    expectedCreditsSha256: manifest.legal?.credits?.sha256,
  });

  const framework = path.join(stageDir, FRAMEWORK_NAME);
  await requireDirectory(framework, 'CEF framework');
  for (const member of [
    'Chromium Embedded Framework',
    'Resources/Info.plist',
    'Resources/icudtl.dat',
    'Libraries/libcef_sandbox.dylib',
  ]) {
    await requireFile(path.join(framework, ...member.split('/')), 'CEF framework member');
  }
  await verifyCefMacosSafeStorageBranding(
    path.join(framework, 'Chromium Embedded Framework'),
    manifest.cef?.safeStorageBranding,
  );
  if (
    !allowUnpinnedDryRun
    && await cefDirectoryTreeSha256(framework) !== pinned.brandedFrameworkTreeSha256
  ) {
    fail(`stage framework tree does not match the official branded ${target} CEF derivation`);
  }

  const manifestHelpers = new Map(
    (manifest.helpers ?? []).map((helper) => [helper.bundle, helper]),
  );
  if (manifestHelpers.size !== HELPER_SPECS.length) {
    fail(`stage manifest must describe exactly ${HELPER_SPECS.length} CEF helpers`);
  }

  const helpers = [];
  for (const spec of HELPER_SPECS) {
    const bundlePath = path.join(stageDir, spec.bundleName);
    const contentsPath = path.join(bundlePath, 'Contents');
    const executablePath = path.join(contentsPath, 'MacOS', spec.executableName);
    const infoPlistPath = path.join(contentsPath, 'Info.plist');
    await requireDirectory(bundlePath, `${spec.bundleName} bundle`);
    await requireFile(executablePath, `${spec.bundleName} executable`);
    await requireFile(infoPlistPath, `${spec.bundleName} Info.plist`);
    await requireFile(path.join(contentsPath, 'PkgInfo'), `${spec.bundleName} PkgInfo`);
    const executableMode = (await fsp.stat(executablePath)).mode;
    if ((executableMode & 0o111) === 0) fail(`${spec.bundleName} executable is not executable`);

    const infoPlist = await fsp.readFile(infoPlistPath, 'utf8');
    if (plistString(infoPlist, 'CFBundleExecutable') !== spec.executableName) {
      fail(`${spec.bundleName} CFBundleExecutable is not exact`);
    }
    if (plistString(infoPlist, 'CFBundleIdentifier') !== spec.bundleIdentifier) {
      fail(`${spec.bundleName} CFBundleIdentifier is not exact`);
    }
    const manifestHelper = manifestHelpers.get(spec.bundleName);
    if (
      manifestHelper?.identifier !== spec.bundleIdentifier
      || manifestHelper?.executable !== `${spec.bundleName}/Contents/MacOS/${spec.executableName}`
    ) {
      fail(`${spec.bundleName} does not match the stage manifest`);
    }
    helpers.push({ ...spec, bundlePath, executablePath });
  }
  return {
    manifest,
    helpers,
    framework: {
      bundlePath: framework,
      bundleIdentifier: CEF_FRAMEWORK_BUNDLE_IDENTIFIER,
      nestedCode: CEF_FRAMEWORK_NESTED_CODE.map((relative) => ({
        relative,
        path: path.join(framework, ...relative.split('/')),
      })),
    },
  };
}

export function resolveSigningIdentity(environment = process.env) {
  const identity = environment.APPLE_SIGNING_IDENTITY ?? '';
  const appleTeamId = environment.APPLE_TEAM_ID ?? '';
  const officialTeamId = environment.CCEM_OFFICIAL_APPLE_TEAM_ID ?? '';
  if (!/^[A-Z0-9]{10}$/.test(officialTeamId)) fail('official Apple Team ID is not pinned');
  if (appleTeamId !== officialTeamId) fail('APPLE_TEAM_ID does not match the official Team ID');
  const identityMatch = identity.match(/^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/);
  if (!identityMatch || identityMatch[1] !== officialTeamId) {
    fail('APPLE_SIGNING_IDENTITY is not the exact official Developer ID Application identity');
  }
  return { identity, teamId: officialTeamId };
}

function signArgs(identity, targetPath, entitlementsPath) {
  return [
    '--force',
    '--sign',
    identity,
    '--options',
    'runtime',
    '--timestamp',
    ...(entitlementsPath ? ['--entitlements', entitlementsPath] : []),
    targetPath,
  ];
}

export function createSigningPlan({ stageDir, framework, helpers, identity }) {
  const helperPlans = helpers.map((helper) => {
    const entitlementsPath = helper.needsJit ? jitEntitlementsPath : null;
    return {
      bundleName: helper.bundleName,
      bundleIdentifier: helper.bundleIdentifier,
      needsJit: helper.needsJit,
      entitlementsPath,
      commands: {
        signExecutable: { program: CODESIGN_PATH, args: signArgs(identity, helper.executablePath, entitlementsPath) },
        signBundle: { program: CODESIGN_PATH, args: signArgs(identity, helper.bundlePath, entitlementsPath) },
        verifyBundle: {
          program: CODESIGN_PATH,
          args: ['--verify', '--deep', '--strict', '--verbose=4', helper.bundlePath],
        },
        inspectBundle: {
          program: CODESIGN_PATH,
          args: ['--display', '--verbose=4', helper.bundlePath],
        },
        inspectEntitlements: {
          program: CODESIGN_PATH,
          args: ['--display', '--entitlements', ':-', helper.bundlePath],
        },
      },
      attestedPath: `Frameworks/${helper.bundleName}`,
    };
  });
  return {
    framework: {
      bundleIdentifier: framework.bundleIdentifier,
      bundlePath: framework.bundlePath,
      nestedCode: framework.nestedCode.map((item) => ({
        ...item,
        commands: {
          sign: { program: CODESIGN_PATH, args: signArgs(identity, item.path, null) },
          verify: {
            program: CODESIGN_PATH,
            args: ['--verify', '--strict', '--verbose=4', item.path],
          },
          inspect: {
            program: CODESIGN_PATH,
            args: ['--display', '--verbose=4', item.path],
          },
          inspectEntitlements: {
            program: CODESIGN_PATH,
            args: ['--display', '--entitlements', ':-', item.path],
          },
        },
      })),
      commands: {
        signBundle: {
          program: CODESIGN_PATH,
          args: signArgs(identity, framework.bundlePath, null),
        },
        verifyBundle: {
          program: CODESIGN_PATH,
          args: ['--verify', '--deep', '--strict', '--verbose=4', framework.bundlePath],
        },
        inspectBundle: {
          program: CODESIGN_PATH,
          args: ['--display', '--verbose=4', framework.bundlePath],
        },
        inspectEntitlements: {
          program: CODESIGN_PATH,
          args: ['--display', '--entitlements', ':-', framework.bundlePath],
        },
      },
      attestedPath: `Frameworks/${FRAMEWORK_NAME}`,
    },
    helpers: helperPlans,
  };
}

function runCodesign(args) {
  const result = spawnSync(CODESIGN_PATH, args, {
    cwd: desktopDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) fail(`cannot execute ${CODESIGN_PATH}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${CODESIGN_PATH} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function entitlementKeys(output) {
  return [...output.matchAll(/<key>\s*([^<]+?)\s*<\/key>/g)].map((match) => match[1]);
}

async function validateJitEntitlementsFile() {
  await requireFile(jitEntitlementsPath, 'CEF JIT entitlements');
  const source = await fsp.readFile(jitEntitlementsPath, 'utf8');
  const keys = [...new Set(entitlementKeys(source))];
  if (
    keys.length !== 1
    || keys[0] !== 'com.apple.security.cs.allow-jit'
    || !/<key>\s*com\.apple\.security\.cs\.allow-jit\s*<\/key>\s*<true\s*\/>/.test(source)
  ) {
    fail('CEF JIT entitlements must grant only com.apple.security.cs.allow-jit');
  }
}

export function validateSignatureInspection({
  inspection,
  entitlements,
  identity,
  teamId,
  bundleIdentifier,
  needsJit,
  label = bundleIdentifier,
}) {
  const identifier = inspection.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  const signedTeamId = inspection.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const authorities = [...inspection.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  const runtimeEnabled = /^CodeDirectory .*flags=.*\bruntime\b.*$/m.test(inspection);
  if (bundleIdentifier && identifier !== bundleIdentifier) {
    fail(`signed identifier mismatch for ${bundleIdentifier}`);
  }
  if (signedTeamId !== teamId) fail(`signed Team ID mismatch for ${label}`);
  if (authorities[0] !== identity) fail(`signed authority mismatch for ${label}`);
  if (!runtimeEnabled) fail(`hardened runtime flag is missing for ${label}`);

  const actualKeys = [...new Set(entitlementKeys(entitlements))].sort();
  const expectedKeys = needsJit ? ['com.apple.security.cs.allow-jit'] : [];
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail(`unexpected entitlements for ${label}: ${actualKeys.join(', ') || 'none'}`);
  }
}

export async function writeAttestationAtomically(attestationPath, attestation) {
  const directory = path.dirname(attestationPath);
  await fsp.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(attestationPath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  let handle;
  try {
    handle = await fsp.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(attestation, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tempPath, attestationPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tempPath, { force: true });
    throw error;
  }
}

function assertCiAuthorization(options) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'macOS') {
    fail('actual CEF signing is allowed only on a macOS GitHub Actions runner');
  }
  if (process.env.CCEM_CEF_ALLOW_CODESIGN !== '1') {
    fail('actual CEF signing requires CCEM_CEF_ALLOW_CODESIGN=1');
  }
  if (process.platform !== 'darwin') fail('actual CEF signing requires the macOS host');
  if (path.resolve(options.stageDir) !== defaultStageDir) {
    fail(`actual CEF signing is restricted to ${defaultStageDir}`);
  }
  if (process.env.CCEM_CEF_TARGET_TRIPLE !== options.target) {
    fail('signed CEF target must exactly match CCEM_CEF_TARGET_TRIPLE');
  }
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { status: 'help' };
  }
  const sourceCommit = resolveSourceCommit();
  const signing = resolveSigningIdentity();
  if (!options.dryRun) assertCiAuthorization(options);
  const stage = await validateStageForSigning(options.stageDir, options.target, {
    allowUnpinnedDryRun: options.dryRun,
  });
  await validateJitEntitlementsFile();
  const plan = createSigningPlan({
    stageDir: options.stageDir,
    framework: stage.framework,
    helpers: stage.helpers,
    identity: signing.identity,
  });
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ target: options.target, sourceCommit, stageDir: options.stageDir, plan }, null, 2)}\n`);
    return { status: 'dry-run', plan };
  }

  const attestationPath = path.join(options.stageDir, SIGNING_ATTESTATION_NAME);
  await fsp.rm(attestationPath, { force: true });
  const verifiedFrameworkCode = [];
  for (const item of plan.framework.nestedCode) {
    runCodesign(item.commands.sign.args);
    runCodesign(item.commands.verify.args);
    const inspection = runCodesign(item.commands.inspect.args);
    const entitlements = runCodesign(item.commands.inspectEntitlements.args);
    validateSignatureInspection({
      inspection,
      entitlements,
      identity: signing.identity,
      teamId: signing.teamId,
      bundleIdentifier: null,
      needsJit: false,
      label: item.relative,
    });
    verifiedFrameworkCode.push(`Frameworks/${FRAMEWORK_NAME}/${item.relative}`);
  }
  runCodesign(plan.framework.commands.signBundle.args);
  runCodesign(plan.framework.commands.verifyBundle.args);
  validateSignatureInspection({
    inspection: runCodesign(plan.framework.commands.inspectBundle.args),
    entitlements: runCodesign(plan.framework.commands.inspectEntitlements.args),
    identity: signing.identity,
    teamId: signing.teamId,
    bundleIdentifier: plan.framework.bundleIdentifier,
    needsJit: false,
  });

  const verifiedHelpers = [];
  for (const item of plan.helpers) {
    runCodesign(item.commands.signExecutable.args);
    runCodesign(item.commands.signBundle.args);
    runCodesign(item.commands.verifyBundle.args);
    const inspection = runCodesign(item.commands.inspectBundle.args);
    const entitlements = runCodesign(item.commands.inspectEntitlements.args);
    validateSignatureInspection({
      inspection,
      entitlements,
      identity: signing.identity,
      teamId: signing.teamId,
      bundleIdentifier: item.bundleIdentifier,
      needsJit: item.needsJit,
    });
    verifiedHelpers.push({
      bundleIdentifier: item.bundleIdentifier,
      bundlePath: item.attestedPath,
      hardenedRuntime: true,
      entitlements: item.needsJit ? ['com.apple.security.cs.allow-jit'] : [],
    });
  }

  const stageDigest = await digestStage(options.stageDir);
  const attestation = {
    schemaVersion: 3,
    verification: SIGNING_VERIFICATION,
    identity: signing.identity,
    teamId: signing.teamId,
    target: options.target,
    profile: 'release',
    sourceCommit,
    cefRuntimeVersion: CEF_FULL_VERSION,
    stageDigest,
    verifiedBundlePaths: [
      plan.framework.attestedPath,
      ...plan.helpers.map((item) => item.attestedPath),
    ],
    verifiedFramework: {
      bundleIdentifier: plan.framework.bundleIdentifier,
      bundlePath: plan.framework.attestedPath,
      nestedCodePaths: verifiedFrameworkCode,
      hardenedRuntime: true,
      entitlements: [],
    },
    verifiedHelpers,
    codesignPath: CODESIGN_PATH,
    createdAt: new Date().toISOString(),
  };
  await writeAttestationAtomically(attestationPath, attestation);
  process.stdout.write(
    `[cef-macos-sign] signed and attested the CEF framework and ${verifiedHelpers.length} helpers\n`,
  );
  return { status: 'signed-and-attested', attestation };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
