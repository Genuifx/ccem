import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CEF_LEGAL_DIRECTORY } from './cef-runtime-contract.mjs';
import {
  RELEASE_INVENTORY_SCHEMA_VERSION,
  readJson,
  sameJson,
  sha256,
  validateInventoryFileBindings,
  validateSourceCommit,
} from './verify-mode2-release-inventory-shared.mjs';
import {
  FRAMEWORK_NAME,
  HELPER_SPECS,
} from './stage-cef-macos.mjs';
import {
  WINDOWS_MAIN_EXECUTABLE_NAME,
  WINDOWS_RUNTIME_FILES,
  WINDOWS_SANDBOX_CLIENT_NAME,
  WINDOWS_SANDBOX_MARKER_NAME,
  WINDOWS_STAGE_MANIFEST,
} from './stage-cef-windows.mjs';
import { verifyTauriUpdaterSignature } from './verify-tauri-updater-signature.mjs';
import {
  HDIUTIL_PATH,
  TAR_PATH,
} from './verify-mode2-release-inventory.mjs';

export const PRODUCTION_SIGNED_RELEASE_MODE = 'production';
export const LEGACY_UNSIGNED_RELEASE_MODE = 'legacy-unsigned';
export const LEGACY_UNSIGNED_PLATFORM_VERIFICATION = 'legacy-unsigned-mode2-runtime-absent';
export const LEGACY_MODE2_EXCLUSION_SCHEMA_VERSION = 1;
export const LEGACY_MODE2_EXCLUSION_VERIFICATION = 'known-mode2-bundle-contract-paths-absent-v1';

const MAC_TARGETS = new Set([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
]);
const WINDOWS_TARGET = 'x86_64-pc-windows-msvc';
const RELEASE_TARGETS = Object.freeze([...MAC_TARGETS, WINDOWS_TARGET]);
const TARGET_ROLES = Object.freeze({
  'aarch64-apple-darwin': ['dmg', 'updater', 'updaterSignature'],
  'x86_64-apple-darwin': ['dmg', 'updater', 'updaterSignature'],
  [WINDOWS_TARGET]: ['updater', 'updaterSignature'],
});
const TARGET_CONTAINERS = Object.freeze({
  'aarch64-apple-darwin': ['app', 'dmg', 'updater'],
  'x86_64-apple-darwin': ['app', 'dmg', 'updater'],
  [WINDOWS_TARGET]: ['installer'],
});

export const LEGACY_MODE2_BUNDLE_DENYLIST = Object.freeze([...new Set([
  FRAMEWORK_NAME,
  ...HELPER_SPECS.map(({ bundleName }) => bundleName),
  'third-party/cef',
  CEF_LEGAL_DIRECTORY,
  WINDOWS_STAGE_MANIFEST,
  WINDOWS_SANDBOX_MARKER_NAME,
  WINDOWS_SANDBOX_CLIENT_NAME,
  ...WINDOWS_RUNTIME_FILES,
].map((value) => value.replaceAll('\\', '/').toLowerCase()))].sort());

export const LEGACY_MODE2_BUNDLE_DENYLIST_SHA256 = createHash('sha256')
  .update(JSON.stringify(LEGACY_MODE2_BUNDLE_DENYLIST))
  .digest('hex');

const scriptPath = fileURLToPath(import.meta.url);

function fail(message) {
  throw new Error(`[legacy-release-inventory] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

function sameSet(actual, expected) {
  return sameJson([...actual].sort(), [...expected].sort());
}

function sameFlatRecord(actual, expected) {
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  const keys = Object.keys(expected);
  return sameSet(Object.keys(actual), keys) && keys.every((key) => actual[key] === expected[key]);
}

async function requireFile(candidate, label) {
  const exact = path.resolve(required(candidate, `${label} path`));
  const stat = await fsp.lstat(exact).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  if (stat.size <= 0) fail(`${label} must not be empty`);
  return { path: exact, stat };
}

async function requireDirectory(candidate, label) {
  const exact = path.resolve(required(candidate, `${label} path`));
  const stat = await fsp.lstat(exact).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink directory`);
  }
  return exact;
}

async function artifactMetadata(candidate, label) {
  const record = await requireFile(candidate, label);
  return {
    fileName: path.basename(record.path),
    sha256: await sha256(record.path),
    size: record.stat.size,
  };
}

function normalizedRelative(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase();
}

function assertNotMode2Path(relative) {
  const normalized = normalizedRelative(relative);
  if (
    LEGACY_MODE2_BUNDLE_DENYLIST.some((denied) => (
      normalized === denied || normalized.endsWith(`/${denied}`)
    ))
    || normalized.split('/').some((segment) => /^ccem-desktop helper(?: \(.+\))?\.app$/u.test(segment))
  ) {
    fail(`Mode 2/CEF runtime path is forbidden in a legacy unsigned bundle: ${relative}`);
  }
}

export async function inspectLegacyBundleTree(root, label = 'legacy bundle') {
  const exactRoot = await requireDirectory(root, label);
  const entries = [];
  const fileContents = [];
  async function visit(directory, relativeRoot) {
    const children = await fsp.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const relative = relativeRoot ? `${relativeRoot}/${child.name}` : child.name;
      assertNotMode2Path(relative);
      const candidate = path.join(directory, child.name);
      const stat = await fsp.lstat(candidate);
      if (stat.isSymbolicLink()) fail(`${label} contains a symlink: ${relative}`);
      if (stat.isDirectory()) {
        entries.push(`directory:${normalizedRelative(relative)}`);
        await visit(candidate, relative);
      } else if (stat.isFile()) {
        const normalized = normalizedRelative(relative);
        entries.push(`file:${normalized}`);
        fileContents.push(`${normalized}:${stat.size}:${await sha256(candidate)}`);
      } else {
        fail(`${label} contains an unsupported filesystem entry: ${relative}`);
      }
    }
  }
  await visit(exactRoot, '');
  if (entries.length === 0) fail(`${label} is empty`);
  entries.sort();
  fileContents.sort();
  return {
    pathCount: entries.length,
    pathSetSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    contentSetSha256: createHash('sha256').update(JSON.stringify(fileContents)).digest('hex'),
  };
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

async function inspectLegacyMacApp(appDir, version, label) {
  const exactApp = await requireDirectory(appDir, label);
  const infoPath = path.join(exactApp, 'Contents', 'Info.plist');
  const info = await requireFile(infoPath, `${label} Info.plist`);
  const source = await fsp.readFile(info.path, 'utf8');
  if (
    plistString(source, 'CFBundleIdentifier') !== 'com.ccem.desktop'
    || plistString(source, 'CFBundleShortVersionString') !== version
    || plistString(source, 'CFBundleVersion') !== version
  ) {
    fail(`${label} does not bind com.ccem.desktop version ${version}`);
  }
  const executableName = plistString(source, 'CFBundleExecutable');
  if (!executableName || path.basename(executableName) !== executableName) {
    fail(`${label} CFBundleExecutable must be an exact basename`);
  }
  const executable = await artifactMetadata(
    path.join(exactApp, 'Contents', 'MacOS', executableName),
    `${label} main executable`,
  );
  return {
    executable,
    tree: await inspectLegacyBundleTree(exactApp, label),
  };
}

async function locateSingleMacApp(root) {
  const matches = [];
  async function visit(directory, depth) {
    if (depth > 5) return;
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.name === 'CCEM Desktop.app') matches.push(candidate);
      else await visit(candidate, depth + 1);
    }
  }
  await visit(root, 0);
  if (matches.length !== 1) fail(`expected exactly one CCEM Desktop.app; found ${matches.length}`);
  return matches[0];
}

function runCommand(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) fail(`cannot execute ${program}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${program} failed (${result.status ?? 'no status'}): ${result.stderr || result.stdout}`);
  }
  return result.stdout ?? '';
}

async function inspectMacUpdaterNative(updaterPath, version) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-updater-'));
  try {
    runCommand(TAR_PATH, ['-xzf', updaterPath, '-C', temporary, '--no-same-owner']);
    return await inspectLegacyMacApp(
      await locateSingleMacApp(temporary),
      version,
      'macOS updater app',
    );
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

async function inspectMacDmgNative(dmgPath, version) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-dmg-'));
  const mountPoint = path.join(temporary, 'mount');
  let mounted = false;
  try {
    await fsp.mkdir(mountPoint);
    runCommand(HDIUTIL_PATH, ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath]);
    mounted = true;
    return await inspectLegacyMacApp(
      await locateSingleMacApp(mountPoint),
      version,
      'macOS DMG app',
    );
  } finally {
    if (mounted) runCommand(HDIUTIL_PATH, ['detach', mountPoint]);
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

async function locateWindowsInstallRoot(root) {
  const matches = [];
  async function visit(directory, depth) {
    if (depth > 8) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === WINDOWS_MAIN_EXECUTABLE_NAME)) {
      matches.push(directory);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(path.join(directory, entry.name), depth + 1);
      }
    }
  }
  await visit(root, 0);
  if (matches.length !== 1) fail(`expected exactly one Windows install root; found ${matches.length}`);
  return matches[0];
}

async function inspectWindowsInstallerNative(installerPath) {
  if (process.platform !== 'win32') fail('Windows installer verification requires a Windows runner');
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-legacy-windows-'));
  try {
    const installed = spawnSync(installerPath, ['/S', '/NS', `/D=${temporary}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      windowsHide: true,
    });
    if (installed.error) fail(`cannot execute Windows installer: ${installed.error.message}`);
    if (installed.status !== 0) {
      fail(`Windows installer failed (${installed.status ?? 'no status'}): ${installed.stderr || installed.stdout}`);
    }
    const installRoot = await locateWindowsInstallRoot(temporary);
    return {
      executable: await artifactMetadata(
        path.join(installRoot, WINDOWS_MAIN_EXECUTABLE_NAME),
        'Windows installed main executable',
      ),
      tree: await inspectLegacyBundleTree(installRoot, 'Windows installer tree'),
    };
  } finally {
    const uninstallers = [];
    async function findUninstallers(directory) {
      for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) await findUninstallers(candidate);
        else if (entry.isFile() && entry.name.toLowerCase() === 'uninstall.exe') {
          uninstallers.push(candidate);
        }
      }
    }
    await findUninstallers(temporary);
    if (uninstallers.length === 1) {
      spawnSync(uninstallers[0], ['/S'], {
        stdio: 'ignore',
        timeout: 60_000,
        windowsHide: true,
      });
    }
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

function exclusionEvidence(inspectedContainers) {
  return {
    schemaVersion: LEGACY_MODE2_EXCLUSION_SCHEMA_VERSION,
    verification: LEGACY_MODE2_EXCLUSION_VERIFICATION,
    denylistSha256: LEGACY_MODE2_BUNDLE_DENYLIST_SHA256,
    denylistEntryCount: LEGACY_MODE2_BUNDLE_DENYLIST.length,
    symlinkPolicy: 'rejected',
    inspectedContainers,
  };
}

export async function inspectLegacyMacRelease(options, operations = {}) {
  if (!MAC_TARGETS.has(options.target)) fail(`unsupported legacy macOS target: ${options.target}`);
  validateSourceCommit(options.sourceCommit);
  required(options.version, 'app version');
  const app = await inspectLegacyMacApp(options.appDir, options.version, 'macOS app');
  const dmg = await artifactMetadata(options.dmgPath, 'macOS DMG');
  const updater = await artifactMetadata(options.updaterPath, 'macOS updater');
  const signaturePath = options.updaterSignaturePath ?? `${options.updaterPath}.sig`;
  const updaterSignature = await artifactMetadata(signaturePath, 'macOS updater signature');
  const signature = await (operations.verifyUpdaterSignature ?? verifyTauriUpdaterSignature)({
    artifactPath: path.resolve(options.updaterPath),
    signaturePath: path.resolve(signaturePath),
  });
  const updaterApp = await (operations.inspectUpdater ?? inspectMacUpdaterNative)(
    path.resolve(options.updaterPath),
    options.version,
  );
  const dmgApp = await (operations.inspectDmg ?? inspectMacDmgNative)(
    path.resolve(options.dmgPath),
    options.version,
  );
  for (const [label, packagedApp] of [
    ['macOS updater app', updaterApp],
    ['macOS DMG app', dmgApp],
  ]) {
    if (
      !packagedApp
      || !sameFlatRecord(packagedApp.executable, app.executable)
      || !sameFlatRecord(packagedApp.tree, app.tree)
    ) {
      fail(`${label} executable/tree does not exactly match the verified macOS app`);
    }
  }
  return {
    schemaVersion: RELEASE_INVENTORY_SCHEMA_VERSION,
    releaseMode: LEGACY_UNSIGNED_RELEASE_MODE,
    platform: options.target,
    appVersion: options.version,
    sourceCommit: options.sourceCommit,
    mode2Included: false,
    cefRuntimeVersion: null,
    helperBundles: [],
    stableCefResources: {},
    platformVerification: LEGACY_UNSIGNED_PLATFORM_VERIFICATION,
    updaterSignatureVerification: signature.algorithm,
    mainExecutable: app.executable,
    mode2Exclusion: exclusionEvidence({
      app: app.tree,
      dmg: dmgApp.tree,
      updater: updaterApp.tree,
    }),
    artifacts: { dmg, updater, updaterSignature },
  };
}

export async function inspectLegacyWindowsRelease(options, operations = {}) {
  if (options.target !== WINDOWS_TARGET) fail(`unsupported legacy Windows target: ${options.target}`);
  validateSourceCommit(options.sourceCommit);
  required(options.version, 'app version');
  const appExecutable = await artifactMetadata(options.appPath, 'Windows build main executable');
  const updater = await artifactMetadata(options.installerPath, 'Windows installer/updater');
  const signaturePath = required(options.updaterSignaturePath, 'Windows updater signature path');
  const updaterSignature = await artifactMetadata(signaturePath, 'Windows updater signature');
  const signature = await (operations.verifyUpdaterSignature ?? verifyTauriUpdaterSignature)({
    artifactPath: path.resolve(options.installerPath),
    signaturePath: path.resolve(signaturePath),
  });
  const installer = await (operations.inspectInstaller ?? inspectWindowsInstallerNative)(
    path.resolve(options.installerPath),
  );
  if (!sameFlatRecord(installer?.executable, appExecutable)) {
    fail('Windows installed main executable does not exactly match the verified build executable');
  }
  return {
    schemaVersion: RELEASE_INVENTORY_SCHEMA_VERSION,
    releaseMode: LEGACY_UNSIGNED_RELEASE_MODE,
    platform: options.target,
    appVersion: options.version,
    sourceCommit: options.sourceCommit,
    mode2Included: false,
    cefRuntimeVersion: null,
    helperBundles: [],
    stableCefResources: {},
    platformVerification: LEGACY_UNSIGNED_PLATFORM_VERIFICATION,
    updaterSignatureVerification: signature.algorithm,
    mainExecutable: appExecutable,
    mode2Exclusion: exclusionEvidence({ installer: installer.tree }),
    artifacts: { updater, updaterSignature },
  };
}

function validateArtifactRecord(record, label) {
  if (
    !record
    || typeof record.fileName !== 'string'
    || path.basename(record.fileName) !== record.fileName
    || ['.', '..', 'latest.json'].includes(record.fileName)
    || /[\u0000-\u001f\u007f]/u.test(record.fileName)
    || !/^[a-f0-9]{64}$/u.test(record.sha256 ?? '')
    || !Number.isSafeInteger(record.size)
    || record.size <= 0
  ) {
    fail(`${label} must bind an exact basename, SHA-256, and positive byte size`);
  }
}

function validateTreeRecord(record, label) {
  if (
    !record
    || !Number.isSafeInteger(record.pathCount)
    || record.pathCount <= 0
    || !/^[a-f0-9]{64}$/u.test(record.pathSetSha256 ?? '')
    || !/^[a-f0-9]{64}$/u.test(record.contentSetSha256 ?? '')
  ) {
    fail(`${label} must bind non-empty path and file-content inventories with SHA-256`);
  }
}

export function validateLegacyUnsignedInventorySet(inventories, expectedVersion, expectedSourceCommit) {
  validateSourceCommit(expectedSourceCommit);
  if (inventories.length !== RELEASE_TARGETS.length) {
    fail(`legacy release inventory set must contain exactly 3 targets; found ${inventories.length}`);
  }
  const platforms = inventories.map(({ platform }) => platform);
  if (!sameSet(platforms, RELEASE_TARGETS) || new Set(platforms).size !== RELEASE_TARGETS.length) {
    fail(`legacy release target inventory mismatch: ${platforms.join(', ')}`);
  }
  const artifactNames = new Set();
  for (const inventory of inventories) {
    const roles = TARGET_ROLES[inventory.platform];
    const containers = TARGET_CONTAINERS[inventory.platform];
    if (
      inventory.schemaVersion !== RELEASE_INVENTORY_SCHEMA_VERSION
      || inventory.releaseMode !== LEGACY_UNSIGNED_RELEASE_MODE
      || inventory.appVersion !== expectedVersion
      || inventory.sourceCommit !== expectedSourceCommit
      || inventory.mode2Included !== false
      || inventory.cefRuntimeVersion !== null
      || !sameJson(inventory.helperBundles, [])
      || !sameJson(inventory.stableCefResources, {})
      || inventory.platformVerification !== LEGACY_UNSIGNED_PLATFORM_VERIFICATION
      || inventory.updaterSignatureVerification !== 'minisign-ed25519-blake2b'
    ) {
      fail(`${inventory.platform} is not an exact legacy unsigned, Mode 2-disabled inventory`);
    }
    if (!sameSet(Object.keys(inventory.artifacts ?? {}), roles)) {
      fail(`${inventory.platform} legacy inventory has an invalid artifact role set`);
    }
    for (const role of roles) validateArtifactRecord(inventory.artifacts[role], `${inventory.platform} ${role}`);
    validateArtifactRecord(inventory.mainExecutable, `${inventory.platform} main executable`);
    if (
      inventory.artifacts.updaterSignature.fileName
      !== `${inventory.artifacts.updater.fileName}.sig`
    ) {
      fail(`${inventory.platform} updater signature does not bind its updater artifact`);
    }
    const exclusion = inventory.mode2Exclusion;
    if (
      exclusion?.schemaVersion !== LEGACY_MODE2_EXCLUSION_SCHEMA_VERSION
      || exclusion.verification !== LEGACY_MODE2_EXCLUSION_VERIFICATION
      || exclusion.denylistSha256 !== LEGACY_MODE2_BUNDLE_DENYLIST_SHA256
      || exclusion.denylistEntryCount !== LEGACY_MODE2_BUNDLE_DENYLIST.length
      || exclusion.symlinkPolicy !== 'rejected'
      || !sameSet(Object.keys(exclusion.inspectedContainers ?? {}), containers)
    ) {
      fail(`${inventory.platform} lacks the exact negative Mode 2 bundle proof`);
    }
    for (const role of containers) {
      validateTreeRecord(exclusion.inspectedContainers[role], `${inventory.platform} ${role}`);
    }
    for (const record of Object.values(inventory.artifacts)) {
      if (artifactNames.has(record.fileName)) fail(`duplicate release artifact basename: ${record.fileName}`);
      artifactNames.add(record.fileName);
    }
  }
  return {
    schemaVersion: RELEASE_INVENTORY_SCHEMA_VERSION,
    releaseMode: LEGACY_UNSIGNED_RELEASE_MODE,
    appVersion: expectedVersion,
    sourceCommit: expectedSourceCommit,
    mode2Included: false,
    cefRuntimeVersion: null,
    targets: inventories.map(({ platform, mode2Included, artifacts, mode2Exclusion }) => ({
      platform,
      mode2Included,
      artifacts,
      mode2Exclusion,
    })),
  };
}

async function writeJsonAtomically(output, value) {
  const absolute = path.resolve(required(output, 'output path'));
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, absolute);
}

function parseArgs(argv) {
  const options = { inventoryFiles: [] };
  const valueOptions = new Map([
    ['--platform', 'platform'],
    ['--target', 'target'],
    ['--version', 'version'],
    ['--source-commit', 'sourceCommit'],
    ['--app', 'appPath'],
    ['--dmg', 'dmgPath'],
    ['--updater', 'updaterPath'],
    ['--installer', 'installerPath'],
    ['--updater-signature', 'updaterSignaturePath'],
    ['--inventory', 'inventoryFiles'],
    ['--output', 'output'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') options.help = true;
    else if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      index += 1;
      const key = valueOptions.get(argument);
      if (key === 'inventoryFiles') options.inventoryFiles.push(path.resolve(value));
      else options[key] = ['platform', 'target', 'version', 'sourceCommit'].includes(key)
        ? value
        : path.resolve(value);
    } else fail(`unknown argument: ${argument}`);
  }
  return options;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node scripts/verify-legacy-release-inventory.mjs --platform <macos|windows|set> --version <version> --source-commit <sha> [artifact options] [--inventory <file> ...] --output <file>\n');
    return { status: 'help' };
  }
  required(options.platform, 'platform');
  required(options.version, 'version');
  required(options.sourceCommit, 'source commit');
  validateSourceCommit(options.sourceCommit);
  let inventory;
  if (options.platform === 'macos') {
    for (const key of ['target', 'appPath', 'dmgPath', 'updaterPath']) required(options[key], key);
    inventory = await inspectLegacyMacRelease({ ...options, appDir: options.appPath });
  } else if (options.platform === 'windows') {
    for (const key of ['target', 'appPath', 'installerPath', 'updaterSignaturePath']) required(options[key], key);
    inventory = await inspectLegacyWindowsRelease(options);
  } else if (options.platform === 'set') {
    const inventories = await Promise.all(options.inventoryFiles.map(
      (candidate) => readJson(candidate, 'legacy release inventory'),
    ));
    // Reuse the exact basename/target binding used by the production set. The
    // legacy producer intentionally emits the same inventory basename contract.
    validateInventoryFileBindings(options.inventoryFiles, inventories);
    inventory = validateLegacyUnsignedInventorySet(
      inventories,
      options.version,
      options.sourceCommit,
    );
  } else {
    fail('--platform must be macos, windows, or set');
  }
  if (options.output) await writeJsonAtomically(options.output, inventory);
  else process.stdout.write(`${JSON.stringify({ inventory }, null, 2)}\n`);
  return { status: 'verified', inventory };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
