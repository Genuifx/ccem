import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CEF_CRATE_VERSION,
  CEF_FULL_VERSION,
  CEF_RUNTIME_VERSION,
  cefArchiveSpec,
  cefDirectoryTreeSha256,
  cefFileSha256,
  inspectStagedCefLegalFiles,
  inspectCefArchiveLegalSource,
  readPinnedCefArchiveIdentity,
  stageCefLegalFiles,
} from './cef-runtime-contract.mjs';
import {
  brandCefMacosSafeStorageService,
  verifyCefMacosSafeStorageBranding,
} from './cef-macos-safe-storage-branding.mjs';
import { requiredMacCefFrameworkFiles } from './macos-cef-bundle-contract.mjs';

export { CEF_CRATE_VERSION, CEF_FULL_VERSION, CEF_RUNTIME_VERSION };
export const FRAMEWORK_NAME = 'Chromium Embedded Framework.framework';
export const MAIN_EXECUTABLE_NAME = 'ccem-desktop';
export const HELPER_BINARY_NAME = 'ccem-cef-helper';
export const STAGE_MANIFEST_NAME = 'cef-staging-manifest.json';
export const SIGNING_ATTESTATION_NAME = 'cef-signing-attestation.json';
export const FRAMEWORK_ATTESTED_PATH = `Frameworks/${FRAMEWORK_NAME}`;
export const SIGNING_ATTESTATION_VERIFICATION = 'strict-deep-external-v2';
export const FRAMEWORK_NESTED_CODE_RELATIVES = Object.freeze([
  'Libraries/libEGL.dylib',
  'Libraries/libGLESv2.dylib',
  'Libraries/libcef_sandbox.dylib',
  'Libraries/libvk_swiftshader.dylib',
]);

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(scriptPath);
const desktopDir = path.resolve(scriptsDir, '..');
const tauriDir = path.join(desktopDir, 'src-tauri');
const tauriConfigPath = path.join(tauriDir, 'tauri.conf.json');
const cargoManifestPath = path.join(tauriDir, 'Cargo.toml');
const defaultStageDir = path.join(tauriDir, 'target', 'cef-bundle', 'macos');

// Chromium's mac helper contract grants JIT only to Renderer (V8) and GPU
// (SwiftShader). The default helper has no exception. CCEM does not load the
// deprecated third-party binary components that require Plugin's broader
// disable-library-validation/unsigned-memory exceptions, so Plugin stays empty.
// Sources:
// https://chromium.googlesource.com/chromium/src/+/master/content/public/app/mac_helpers.gni
// https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/app/helper-renderer-entitlements.plist
// https://developer.apple.com/documentation/security/hardened-runtime
const helperKinds = [
  { suffix: 'Helper (GPU)', idSuffix: 'helper.gpu', needsJit: true },
  { suffix: 'Helper (Renderer)', idSuffix: 'helper.renderer', needsJit: true },
  { suffix: 'Helper (Plugin)', idSuffix: 'helper.plugin', needsJit: false },
  { suffix: 'Helper (Alerts)', idSuffix: 'helper.alerts', needsJit: false },
  { suffix: 'Helper', idSuffix: 'helper', needsJit: false },
];

export const HELPER_SPECS = helperKinds.map(({ suffix, idSuffix, needsJit }) => {
  const executableName = `${MAIN_EXECUTABLE_NAME} ${suffix}`;
  return {
    suffix,
    executableName,
    bundleName: `${executableName}.app`,
    bundleIdentifier: `com.ccem.desktop.${idSuffix}`,
    needsJit,
  };
});

export const HELPER_BUNDLE_NAMES = HELPER_SPECS.map(({ bundleName }) => bundleName);

function fail(message) {
  throw new Error(`[cef-macos-stage] ${message}`);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    prepareForSigning: false,
    printStageDigest: false,
    fixtureDir: null,
    outputDir: defaultStageDir,
    target: null,
    profile: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--prepare-for-signing') {
      options.prepareForSigning = true;
    } else if (arg === '--print-stage-digest') {
      options.printStageDigest = true;
    } else if (['--fixture', '--output', '--target', '--profile'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${arg} requires a value`);
      index += 1;
      if (arg === '--fixture') options.fixtureDir = path.resolve(value);
      if (arg === '--output') options.outputDir = path.resolve(value);
      if (arg === '--target') options.target = value;
      if (arg === '--profile') options.profile = value;
    } else if (arg === '--help') {
      options.help = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/stage-cef-macos.mjs [options]\n\n`);
  process.stdout.write(`  --dry-run                 Print the resolved plan without building or copying\n`);
  process.stdout.write(`  --fixture <dir>           Use <dir>/runtime and <dir>/ccem-cef-helper\n`);
  process.stdout.write(`  --output <dir>            Override the atomic staging destination\n`);
  process.stdout.write(`  --target <triple>         Override the macOS Rust target triple\n`);
  process.stdout.write(`  --profile <release|debug> Override the Cargo/bundle profile\n`);
  process.stdout.write(`  --prepare-for-signing     Stage unsigned nested code for an external signer\n`);
  process.stdout.write(`  --print-stage-digest      Hash an externally signed stage for attestation\n`);
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').toLowerCase());
}

function signingConfiguration() {
  const certificateConfigured = Boolean(process.env.APPLE_CERTIFICATE);
  const certificatePasswordConfigured = Boolean(process.env.APPLE_CERTIFICATE_PASSWORD);
  if (certificateConfigured !== certificatePasswordConfigured) {
    fail('Apple certificate and certificate password must be configured together');
  }

  const identityConfigured = Boolean(process.env.APPLE_SIGNING_IDENTITY);
  const teamConfigured = Boolean(process.env.APPLE_TEAM_ID);
  if (identityConfigured !== teamConfigured) {
    fail('Apple signing identity and Team ID must be configured together');
  }

  const identity = process.env.APPLE_SIGNING_IDENTITY ?? null;
  const teamId = process.env.CCEM_OFFICIAL_APPLE_TEAM_ID
    ?? process.env.APPLE_TEAM_ID
    ?? null;
  const required = identityConfigured || envFlag('CCEM_CEF_REQUIRE_PRE_SIGNED');
  if (
    process.env.CCEM_OFFICIAL_APPLE_TEAM_ID
    && process.env.APPLE_TEAM_ID
    && process.env.CCEM_OFFICIAL_APPLE_TEAM_ID !== process.env.APPLE_TEAM_ID
  ) {
    fail('APPLE_TEAM_ID does not match the official Apple Team ID');
  }
  if (required && (!identity || !teamId)) {
    fail('pre-signing requires APPLE_SIGNING_IDENTITY and an official Apple Team ID');
  }
  return { required, identity, teamId };
}

function requiredSourceCommit() {
  const sourceCommit = process.env.GITHUB_SHA?.trim();
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '')) {
    fail('GITHUB_SHA must identify the exact source commit for a pre-signed CEF stage');
  }
  return sourceCommit;
}

function normalizeArch(value) {
  if (['arm64', 'aarch64'].includes(value)) return 'aarch64';
  if (['x64', 'x86_64', 'amd64'].includes(value)) return 'x86_64';
  fail(`unsupported macOS architecture: ${value}`);
}

function hostTargetTriple() {
  const result = spawnSync('rustc', ['--print', 'host-tuple'], {
    cwd: tauriDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();

  const verbose = spawnSync('rustc', ['-vV'], {
    cwd: tauriDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const match = verbose.status === 0 && verbose.stdout.match(/^host:\s+(\S+)$/m);
  if (!match) fail(`cannot determine Rust host target: ${verbose.stderr || result.stderr}`);
  return match[1];
}

function resolveTarget(explicitTarget, dryRun) {
  const direct = explicitTarget
    ?? process.env.CCEM_CEF_TARGET_TRIPLE
    ?? process.env.CARGO_BUILD_TARGET;
  if (direct) {
    if (!/^(aarch64|x86_64)-apple-darwin$/.test(direct)) {
      fail(`Mode 2 macOS bundles do not support target ${direct}`);
    }
    return direct;
  }

  if (process.env.TAURI_ENV_ARCH) {
    return `${normalizeArch(process.env.TAURI_ENV_ARCH)}-apple-darwin`;
  }

  if (dryRun) {
    const hostArch = process.arch === 'arm64' ? 'aarch64' : process.arch;
    return `${normalizeArch(hostArch)}-apple-darwin`;
  }

  const target = hostTargetTriple();
  if (!/^(aarch64|x86_64)-apple-darwin$/.test(target)) {
    fail(`host target ${target} is not a supported macOS release target`);
  }
  return target;
}

function resolveProfile(explicitProfile) {
  const requested = explicitProfile
    ?? process.env.CCEM_CEF_BUNDLE_PROFILE
    ?? (envFlag('TAURI_ENV_DEBUG') ? 'debug' : 'release');
  if (requested === 'dev') return 'debug';
  if (!['debug', 'release'].includes(requested)) {
    fail(`unsupported bundle profile: ${requested}`);
  }
  return requested;
}

function targetArch(target) {
  return normalizeArch(target.split('-')[0]);
}

function runtimeDirectoryName(target) {
  return `cef_macos_${targetArch(target)}`;
}

function cargoMetadata() {
  const result = spawnSync(
    'cargo',
    ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', cargoManifestPath],
    {
      cwd: tauriDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) fail(`cargo metadata failed:\n${result.stderr}`);
  const metadata = JSON.parse(result.stdout);
  if (!metadata.target_directory) fail('cargo metadata did not return target_directory');
  return metadata;
}

function buildHelper(target, profile) {
  const args = [
    'build',
    '--locked',
    '--manifest-path',
    cargoManifestPath,
    '--bin',
    HELPER_BINARY_NAME,
    '--target',
    target,
  ];
  if (profile === 'release') args.push('--release');
  const result = spawnSync('cargo', args, {
    cwd: tauriDir,
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`cargo ${args.join(' ')} failed with status ${result.status}`);
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

async function canonicalExistingDirectories(candidates) {
  const unique = new Map();
  for (const candidate of candidates) {
    if (await pathType(candidate) !== 'directory') continue;
    const canonical = await fsp.realpath(candidate);
    unique.set(canonical, canonical);
  }
  return [...unique.values()];
}

async function runtimeCandidatesFromOutDir(targetDir, target, profile) {
  const buildDir = path.join(targetDir, target, profile, 'build');
  let entries;
  try {
    entries = await fsp.readdir(buildDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('cef-dll-sys-'))
    .map((entry) => path.join(buildDir, entry.name, 'out', runtimeDirectoryName(target)));
}

export async function resolveRuntime({
  target,
  targetDir,
  profile,
  fixtureDir,
  cefPath = process.env.CEF_PATH,
  expectedFrameworkExecutableSha256,
  expectedFrameworkTreeSha256,
}) {
  const runtimeName = runtimeDirectoryName(target);
  let candidates;
  let source;
  if (fixtureDir) {
    candidates = [path.join(fixtureDir, 'runtime')];
    source = 'fixture';
  } else if (cefPath) {
    const configured = path.resolve(cefPath);
    candidates = [
      path.join(configured, CEF_RUNTIME_VERSION, runtimeName),
      path.join(configured, runtimeName),
      configured,
    ];
    source = 'CEF_PATH';
  } else {
    candidates = await runtimeCandidatesFromOutDir(targetDir, target, profile);
    source = 'Cargo OUT_DIR';
  }

  const matches = await canonicalExistingDirectories(candidates);
  const valid = [];
  const invalid = [];
  for (const candidate of matches) {
    try {
      const validation = await validateRuntime(candidate, target, {
        allowUnpinnedFixture: source === 'fixture',
        expectedFrameworkExecutableSha256,
        expectedFrameworkTreeSha256,
      });
      valid.push({ directory: candidate, ...validation });
    } catch (error) {
      invalid.push(`${candidate}: ${error.message}`);
    }
  }
  if (valid.length !== 1) {
    fail(
      `expected exactly one valid CEF ${CEF_RUNTIME_VERSION} runtime from ${source}; `
      + `found ${valid.length}. ${invalid.join(' | ')}`,
    );
  }
  return { ...valid[0], source };
}

async function requireRegularFile(filePath, label) {
  const type = await pathType(filePath);
  if (type !== 'file') fail(`${label} must be a regular file: ${filePath} (${type})`);
}

export async function validateRuntime(
  runtimeDir,
  target,
  {
    allowUnpinnedFixture = false,
    expectedFrameworkExecutableSha256 = cefArchiveSpec(target).frameworkExecutableSha256,
    expectedFrameworkTreeSha256 = cefArchiveSpec(target).frameworkTreeSha256,
  } = {},
) {
  const headerPath = path.join(runtimeDir, 'include', 'cef_version.h');
  await requireRegularFile(headerPath, 'CEF version header');
  const header = await fsp.readFile(headerPath, 'utf8');
  const version = header.match(/^#define CEF_VERSION "([^"]+)"$/m)?.[1];
  if (version !== CEF_FULL_VERSION) {
    fail(`CEF runtime version mismatch: expected ${CEF_FULL_VERSION}, found ${version ?? 'none'}`);
  }

  const framework = path.join(runtimeDir, FRAMEWORK_NAME);
  if (await pathType(framework) !== 'directory') fail(`CEF framework is missing: ${framework}`);
  const frameworkExecutable = path.join(framework, 'Chromium Embedded Framework');
  await requireRegularFile(frameworkExecutable, 'CEF framework executable');
  const frameworkExecutableSha256 = await cefFileSha256(frameworkExecutable);
  if (!allowUnpinnedFixture && frameworkExecutableSha256 !== expectedFrameworkExecutableSha256) {
    fail(
      `CEF framework executable digest mismatch for ${target}: expected `
      + `${expectedFrameworkExecutableSha256}, found ${frameworkExecutableSha256}`,
    );
  }
  const requiredFiles = requiredMacCefFrameworkFiles(target)
    .map((relative) => path.join(framework, ...relative.split('/')));
  for (const required of requiredFiles) await requireRegularFile(required, 'CEF runtime member');
  const frameworkTreeSha256 = await cefDirectoryTreeSha256(framework);
  if (!allowUnpinnedFixture && frameworkTreeSha256 !== expectedFrameworkTreeSha256) {
    fail(
      `CEF framework tree digest mismatch for ${target}: expected `
      + `${expectedFrameworkTreeSha256}, found ${frameworkTreeSha256}`,
    );
  }
  await inspectCefArchiveLegalSource(runtimeDir, target);
  return {
    version,
    frameworkExecutableSha256,
    frameworkTreeSha256,
    sourceFrameworkPinned: !allowUnpinnedFixture
      && expectedFrameworkExecutableSha256 === cefArchiveSpec(target).frameworkExecutableSha256
      && expectedFrameworkTreeSha256 === cefArchiveSpec(target).frameworkTreeSha256,
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function helperInfoPlist({ executableName, bundleIdentifier, version, minimumSystemVersion }) {
  const value = xmlEscape;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>English</string>
  <key>CFBundleDisplayName</key><string>${value(executableName)}</string>
  <key>CFBundleExecutable</key><string>${value(executableName)}</string>
  <key>CFBundleIdentifier</key><string>${value(bundleIdentifier)}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${value(executableName)}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${value(version)}</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleVersion</key><string>${value(version)}</string>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>LSFileQuarantineEnabled</key><true/>
  <key>LSMinimumSystemVersion</key><string>${value(minimumSystemVersion)}</string>
  <key>LSUIElement</key><true/>
  <key>NSBluetoothAlwaysUsageDescription</key><string>${value(executableName)}</string>
  <key>NSCameraUsageDescription</key><string>${value(executableName)}</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>${value(executableName)}</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSWebBrowserPublicKeyCredentialUsageDescription</key><string>${value(executableName)}</string>
</dict>
</plist>
`;
}

async function copyHelperBundle({ root, helperBinary, helper, appVersion, minimumSystemVersion }) {
  const executableName = `${MAIN_EXECUTABLE_NAME} ${helper.suffix}`;
  const appDir = path.join(root, `${executableName}.app`);
  const contents = path.join(appDir, 'Contents');
  const executable = path.join(contents, 'MacOS', executableName);
  await fsp.mkdir(path.dirname(executable), { recursive: true });
  await fsp.mkdir(path.join(contents, 'Frameworks'), { recursive: true });
  await fsp.mkdir(path.join(contents, 'Resources'), { recursive: true });
  await fsp.copyFile(helperBinary, executable);
  await fsp.chmod(executable, 0o755);
  await fsp.writeFile(
    path.join(contents, 'Info.plist'),
    helperInfoPlist({
      executableName,
      bundleIdentifier: `com.ccem.desktop.${helper.idSuffix}`,
      version: appVersion,
      minimumSystemVersion,
    }),
  );
  await fsp.writeFile(path.join(contents, 'PkgInfo'), 'APPL????');
  return {
    bundle: `${executableName}.app`,
    executable: `${executableName}.app/Contents/MacOS/${executableName}`,
    identifier: `com.ccem.desktop.${helper.idSuffix}`,
  };
}

async function hashFile(filePath, hash) {
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
}

async function walkStage(root, current = '') {
  const absolute = path.join(root, current);
  const entries = await fsp.readdir(absolute, { withFileTypes: true });
  const results = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.posix.join(current.split(path.sep).join(path.posix.sep), entry.name);
    if ([STAGE_MANIFEST_NAME, SIGNING_ATTESTATION_NAME].includes(relative)) continue;
    const entryPath = path.join(root, ...relative.split('/'));
    const stat = await fsp.lstat(entryPath);
    if (stat.isDirectory()) {
      results.push({ relative, type: 'directory', mode: stat.mode & 0o777 });
      results.push(...await walkStage(root, relative));
    } else if (stat.isSymbolicLink()) {
      results.push({
        relative,
        type: 'symlink',
        mode: stat.mode & 0o777,
        target: await fsp.readlink(entryPath),
      });
    } else if (stat.isFile()) {
      results.push({ relative, type: 'file', mode: stat.mode & 0o777 });
    } else {
      fail(`unsupported staged filesystem member: ${relative}`);
    }
  }
  return results;
}

export async function digestStage(root) {
  const hash = createHash('sha256');
  const entries = await walkStage(root);
  for (const entry of entries) {
    hash.update(`${entry.type}\0${entry.relative}\0${entry.mode.toString(8)}\0`);
    if (entry.type === 'file') await hashFile(path.join(root, ...entry.relative.split('/')), hash);
    if (entry.type === 'symlink') hash.update(entry.target);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function readJson(jsonPath, label) {
  try {
    return JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`cannot read ${label} ${jsonPath}: ${error.message}`);
  }
}

async function validatePreSignedStage({
  outputDir,
  target,
  profile,
  sourceCommit,
  signing,
  allowUnpinnedFixture = false,
}) {
  if (await pathType(outputDir) !== 'directory') return 'staging directory is missing';
  const manifest = await readJson(path.join(outputDir, STAGE_MANIFEST_NAME), 'stage manifest');
  const attestation = await readJson(
    path.join(outputDir, SIGNING_ATTESTATION_NAME),
    'signing attestation',
  );
  if (!manifest) return 'stage manifest is missing';
  if (!attestation) return 'external signing attestation is missing';
  if (manifest.schemaVersion !== 1 || manifest.cef?.runtimeVersion !== CEF_FULL_VERSION) {
    return 'stage manifest version is not trusted';
  }
  const expectedSourceFrameworkSha256 = cefArchiveSpec(target).frameworkExecutableSha256;
  const expectedBrandedFrameworkSha256 = cefArchiveSpec(target).brandedFrameworkExecutableSha256;
  const expectedSourceFrameworkTreeSha256 = cefArchiveSpec(target).frameworkTreeSha256;
  const expectedBrandedFrameworkTreeSha256 = cefArchiveSpec(target).brandedFrameworkTreeSha256;
  const expectedSafeStorageByteOffset = cefArchiveSpec(target).safeStorageByteOffset;
  if (!allowUnpinnedFixture && (
    manifest.cef?.sourceFrameworkPinned !== true
    || manifest.cef?.sourceFrameworkExecutableSha256 !== expectedSourceFrameworkSha256
    || manifest.cef?.sourceFrameworkTreeSha256 !== expectedSourceFrameworkTreeSha256
    || manifest.cef?.brandedFrameworkTreeSha256 !== expectedBrandedFrameworkTreeSha256
    || manifest.cef?.safeStorageBranding?.sourceExecutableSha256
      !== expectedSourceFrameworkSha256
    || manifest.cef?.safeStorageBranding?.brandedExecutableSha256
      !== expectedBrandedFrameworkSha256
    || manifest.cef?.safeStorageBranding?.byteOffset !== expectedSafeStorageByteOffset
  )) {
    return 'stage manifest does not bind the official target CEF framework digest';
  }
  try {
    await verifyCefMacosSafeStorageBranding(
      path.join(outputDir, FRAMEWORK_NAME, 'Chromium Embedded Framework'),
      manifest.cef?.safeStorageBranding,
      { allowSignedExecutable: true },
    );
  } catch (error) {
    return `stage Safe Storage branding is invalid: ${error.message}`;
  }
  try {
    await inspectStagedCefLegalFiles(outputDir, target, manifest.legal, {
      expectedCreditsSha256: manifest.legal?.credits?.sha256,
    });
  } catch (error) {
    return `stage legal inventory is invalid: ${error.message}`;
  }
  if (manifest.build?.target !== target || manifest.build?.profile !== profile) {
    return `stage was built for ${manifest.build?.target}/${manifest.build?.profile}`;
  }
  if (
    attestation.schemaVersion !== 3
    || attestation.verification !== SIGNING_ATTESTATION_VERIFICATION
    || attestation.target !== target
    || attestation.profile !== profile
    || attestation.sourceCommit !== sourceCommit
    || attestation.cefRuntimeVersion !== CEF_FULL_VERSION
  ) {
    return 'external signing attestation schema is invalid';
  }
  if (attestation.identity !== signing.identity || attestation.teamId !== signing.teamId) {
    return 'external signing attestation identity does not match release configuration';
  }
  const requiredPaths = [
    FRAMEWORK_ATTESTED_PATH,
    ...HELPER_BUNDLE_NAMES.map((name) => `Frameworks/${name}`),
  ];
  if (
    !Array.isArray(attestation.verifiedBundlePaths)
    || attestation.verifiedBundlePaths.length !== requiredPaths.length
    || requiredPaths.some((required) => !attestation.verifiedBundlePaths.includes(required))
  ) {
    return 'external signing attestation does not cover the CEF framework and every Helper.app';
  }
  if (
    attestation.verifiedFramework?.bundleIdentifier !== 'org.cef.framework'
    || attestation.verifiedFramework?.bundlePath !== FRAMEWORK_ATTESTED_PATH
    || attestation.verifiedFramework?.hardenedRuntime !== true
    || JSON.stringify(attestation.verifiedFramework?.nestedCodePaths) !== JSON.stringify(
      FRAMEWORK_NESTED_CODE_RELATIVES.map(
        (relative) => `${FRAMEWORK_ATTESTED_PATH}/${relative}`,
      ),
    )
    || !Array.isArray(attestation.verifiedFramework?.entitlements)
    || attestation.verifiedFramework.entitlements.length !== 0
  ) {
    return 'external signing attestation does not cover the complete CEF framework';
  }
  const currentDigest = await digestStage(outputDir);
  if (attestation.stageDigest !== currentDigest) return 'staged nested code changed after signing';
  return null;
}

async function withStageLock(outputDir, callback) {
  const parent = path.dirname(outputDir);
  const lockDir = path.join(parent, `.${path.basename(outputDir)}.lock`);
  await fsp.mkdir(parent, { recursive: true });
  try {
    await fsp.mkdir(lockDir);
  } catch (error) {
    if (error.code === 'EEXIST') fail(`another CEF staging process owns ${lockDir}`);
    throw error;
  }
  try {
    return await callback();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true });
  }
}

async function replaceDirectoryAtomically(tempDir, outputDir) {
  const backup = `${outputDir}.old-${process.pid}-${randomBytes(4).toString('hex')}`;
  const existed = await pathType(outputDir) === 'directory';
  if (existed) await fsp.rename(outputDir, backup);
  try {
    await fsp.rename(tempDir, outputDir);
  } catch (error) {
    if (existed && await pathType(backup) === 'directory') await fsp.rename(backup, outputDir);
    throw error;
  }
  if (existed) await fsp.rm(backup, { recursive: true, force: true });
}

async function readBundleConfiguration() {
  const config = JSON.parse(await fsp.readFile(tauriConfigPath, 'utf8'));
  return {
    appVersion: config.version,
    minimumSystemVersion: config.bundle?.macOS?.minimumSystemVersion ?? '10.15',
  };
}

async function stage({ runtime, helperBinary, outputDir, target, profile }) {
  await requireRegularFile(helperBinary, 'CEF helper binary');
  const helperMode = (await fsp.stat(helperBinary)).mode;
  if ((helperMode & 0o111) === 0) fail(`CEF helper binary is not executable: ${helperBinary}`);
  const { appVersion, minimumSystemVersion } = await readBundleConfiguration();

  await withStageLock(outputDir, async () => {
    const parent = path.dirname(outputDir);
    const tempDir = path.join(
      parent,
      `.${path.basename(outputDir)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
    );
    await fsp.rm(tempDir, { recursive: true, force: true });
    await fsp.mkdir(tempDir, { recursive: true });
    try {
      await fsp.cp(
        path.join(runtime.directory, FRAMEWORK_NAME),
        path.join(tempDir, FRAMEWORK_NAME),
        { recursive: true, dereference: false, force: false },
      );
      const safeStorageBranding = await brandCefMacosSafeStorageService(
        path.join(tempDir, FRAMEWORK_NAME, 'Chromium Embedded Framework'),
      );
      const brandedFrameworkTreeSha256 = await cefDirectoryTreeSha256(
        path.join(tempDir, FRAMEWORK_NAME),
      );
      if (safeStorageBranding.sourceExecutableSha256 !== runtime.frameworkExecutableSha256) {
        fail('Safe Storage branding source digest differs from the validated CEF framework');
      }
      if (runtime.sourceFrameworkPinned) {
        const pinned = cefArchiveSpec(target);
        if (
          safeStorageBranding.sourceExecutableSha256 !== pinned.frameworkExecutableSha256
          || safeStorageBranding.brandedExecutableSha256
            !== pinned.brandedFrameworkExecutableSha256
          || safeStorageBranding.byteOffset !== pinned.safeStorageByteOffset
          || runtime.frameworkTreeSha256 !== pinned.frameworkTreeSha256
          || brandedFrameworkTreeSha256 !== pinned.brandedFrameworkTreeSha256
        ) {
          fail(`Safe Storage branding differs from the official ${target} CEF derivation`);
        }
      }
      const archive = await readPinnedCefArchiveIdentity(runtime.directory, target);
      const legal = await stageCefLegalFiles({
        runtimeRoot: runtime.directory,
        outputRoot: tempDir,
        target,
      });
      const helpers = [];
      for (const helper of helperKinds) {
        helpers.push(await copyHelperBundle({
          root: tempDir,
          helperBinary,
          helper,
          appVersion,
          minimumSystemVersion,
        }));
      }

      const unsignedStageDigest = await digestStage(tempDir);
      const manifest = {
        schemaVersion: 1,
        cef: {
          crateVersion: CEF_CRATE_VERSION,
          runtimeVersion: runtime.version,
          source: runtime.source,
          sourceDirectory: runtime.directory,
          sourceFrameworkExecutableSha256: runtime.frameworkExecutableSha256,
          sourceFrameworkTreeSha256: runtime.frameworkTreeSha256,
          brandedFrameworkTreeSha256,
          sourceFrameworkPinned: runtime.sourceFrameworkPinned,
          framework: FRAMEWORK_NAME,
          archive,
          safeStorageBranding,
        },
        build: { target, profile, helperBinary },
        layout: {
          release: 'bundled-only',
          looseHelperIncluded: false,
        },
        helpers,
        legal,
        unsignedStageDigest,
        tauriSigningCoverage: {
          frameworkDeclaredViaMacOSFrameworks: true,
          helperAppsDeclaredViaCustomFiles: true,
          helperAppsAutomaticallyAddedToSignPaths: false,
        },
        externalSigning: {
          attestationFile: SIGNING_ATTESTATION_NAME,
          requiredVerification: SIGNING_ATTESTATION_VERIFICATION,
          requiredBundlePaths: [
            FRAMEWORK_ATTESTED_PATH,
            ...HELPER_BUNDLE_NAMES.map((name) => `Frameworks/${name}`),
          ],
          note: 'Sign and verify the official branded CEF framework and every custom Helper.app before Tauri bundling.',
        },
      };
      await fsp.writeFile(
        path.join(tempDir, STAGE_MANIFEST_NAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await replaceDirectoryAtomically(tempDir, outputDir);
    } catch (error) {
      await fsp.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  });
}

function platformIsMacOS(fixtureDir) {
  if (fixtureDir) return true;
  const platform = process.env.TAURI_ENV_PLATFORM;
  if (platform) return ['macos', 'darwin'].includes(platform.toLowerCase());
  return process.platform === 'darwin';
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { status: 'help' };
  }
  if (options.printStageDigest) {
    if (await pathType(options.outputDir) !== 'directory') {
      fail(`staging directory is missing: ${options.outputDir}`);
    }
    const digest = await digestStage(options.outputDir);
    process.stdout.write(`${digest}\n`);
    return { status: 'stage-digest', digest };
  }
  if (!platformIsMacOS(options.fixtureDir)) {
    process.stdout.write('[cef-macos-stage] non-macOS bundle; skipped\n');
    return { status: 'skipped' };
  }

  const target = resolveTarget(options.target, options.dryRun);
  const profile = resolveProfile(options.profile);
  const signing = signingConfiguration();
  const basePlan = {
    target,
    profile,
    outputDir: options.outputDir,
    fixtureDir: options.fixtureDir,
    signingRequired: signing.required,
    prepareForSigning: options.prepareForSigning,
    cargo: options.fixtureDir ? null : {
      program: 'cargo',
      args: [
        'build',
        '--locked',
        '--manifest-path',
        cargoManifestPath,
        '--bin',
        HELPER_BINARY_NAME,
        '--target',
        target,
        ...(profile === 'release' ? ['--release'] : []),
      ],
    },
    helpers: HELPER_BUNDLE_NAMES,
  };
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(basePlan, null, 2)}\n`);
    return { status: 'dry-run', plan: basePlan };
  }

  if (signing.required && !options.prepareForSigning) {
    const sourceCommit = requiredSourceCommit();
    const invalid = await validatePreSignedStage({
      outputDir: options.outputDir,
      target,
      profile,
      sourceCommit,
      signing,
      allowUnpinnedFixture: Boolean(options.fixtureDir),
    });
    if (invalid) {
      fail(
        `Apple signing is enabled but the CEF stage is not validly pre-signed: ${invalid}. `
        + 'Run the explicit prepare/sign/attest release step before Tauri bundling.',
      );
    }
    process.stdout.write('[cef-macos-stage] verified external pre-signing attestation; reusing stage\n');
    return { status: 'reused-pre-signed', plan: basePlan };
  }

  let targetDir;
  let helperBinary;
  if (options.fixtureDir) {
    targetDir = null;
    helperBinary = path.join(options.fixtureDir, HELPER_BINARY_NAME);
  } else {
    const metadata = cargoMetadata();
    targetDir = metadata.target_directory;
    buildHelper(target, profile);
    helperBinary = path.join(targetDir, target, profile, HELPER_BINARY_NAME);
  }
  const runtime = await resolveRuntime({
    target,
    targetDir,
    profile,
    fixtureDir: options.fixtureDir,
  });
  await stage({ runtime, helperBinary, outputDir: options.outputDir, target, profile });

  if (signing.required) {
    process.stdout.write(
      `[cef-macos-stage] prepared unsigned stage at ${options.outputDir}; external signing and attestation are required\n`,
    );
    return { status: 'prepared-for-signing', plan: basePlan };
  }
  process.stdout.write(`[cef-macos-stage] staged CEF ${runtime.version} at ${options.outputDir}\n`);
  return { status: 'staged', plan: basePlan };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
