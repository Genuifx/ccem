import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CEF_FULL_VERSION,
  CEF_LEGAL_DIRECTORY,
  CEF_LEGAL_FILES,
  CEF_LICENSE_SOURCE_PATH,
  CEF_SOURCE_FILE_SET_HASH_ALGORITHM,
  cefArchiveSpec,
  cefFileSetSha256,
  cefFileSha256,
  inspectCefArchiveLegalSource,
  inspectStagedCefLegalFiles,
  readPinnedCefArchiveIdentity,
  stageCefLegalFiles,
} from './cef-runtime-contract.mjs';
import { validateWindowsReleaseSigning } from './validate-release-signing-config.mjs';
import { canonicalPeFileSha256 } from './windows-pe-contract.mjs';

export const WINDOWS_TARGET = 'x86_64-pc-windows-msvc';
export const WINDOWS_STAGE_MANIFEST = 'cef-windows-staging-manifest.json';
export const WINDOWS_RUNTIME_FILES = [
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'chrome_elf.dll',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'dxil.dll',
  'icudtl.dat',
  'libcef.dll',
  'libEGL.dll',
  'libGLESv2.dll',
  'resources.pak',
  'v8_context_snapshot.bin',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
];
export const WINDOWS_MAIN_EXECUTABLE_NAME = 'ccem-desktop.exe';
export const WINDOWS_SANDBOX_CLIENT_NAME = 'ccem-desktop.dll';
export const WINDOWS_SOURCE_CLIENT_NAME = 'ccem_desktop.dll';
export const WINDOWS_SANDBOX_MARKER_NAME = 'cef-windows-sandbox-artifact.json';
export const WINDOWS_SOURCE_BOOTSTRAP_NAME = 'bootstrap.exe';
export const WINDOWS_SANDBOX_ENTRY_POINT = 'RunWinMain';
export const WINDOWS_CEF_API_VERSION = 15000;

// CEF 150's supported Windows sandbox layout uses the official bootstrap.exe
// plus a client DLL exporting RunWinMain. A normal Cargo executable built with
// no_sandbox=1 is intentionally not accepted as a release artifact.
// https://cef-builds.spotifycdn.com/docs/150.0/cef__sandbox__win_8h.html
export const WINDOWS_SANDBOX_MARKER = Object.freeze({
  schemaVersion: 4,
  target: WINDOWS_TARGET,
  cefRuntimeVersion: CEF_FULL_VERSION,
  cefApiVersion: WINDOWS_CEF_API_VERSION,
  cefApiHashEntry: 0,
  sandboxEnabled: true,
  noSandboxAllowed: false,
  sameExecutableSubprocesses: true,
  browserSubprocessPath: null,
  sourceBootstrapExecutable: WINDOWS_SOURCE_BOOTSTRAP_NAME,
  bootstrapExecutable: WINDOWS_MAIN_EXECUTABLE_NAME,
  clientLibrary: WINDOWS_SANDBOX_CLIENT_NAME,
  clientEntryPoint: WINDOWS_SANDBOX_ENTRY_POINT,
  clientEntryPointArgumentCount: 5,
  tauriBundleType: 'NSS',
});
const WINDOWS_SANDBOX_MARKER_DYNAMIC_FIELDS = [
  'gitSha',
  'cefArchiveName',
  'cefArchiveSha1',
  'cefArchiveSha256',
  'cefRuntimeFileSetHashAlgorithm',
  'cefRuntimeFileSetSha256',
  'cefRuntimeLocaleCount',
  'cefCreditsSha256',
  'unsignedBootstrapSha256',
  'unsignedClientLibrarySha256',
  'bootstrapCanonicalSha256',
  'clientCanonicalSha256',
];

const WINDOWS_STAGE_FILES = [
  ...WINDOWS_RUNTIME_FILES,
  WINDOWS_SANDBOX_CLIENT_NAME,
  WINDOWS_SANDBOX_MARKER_NAME,
];
export const WINDOWS_SIGNED_RESOURCE_FILES = [
  ...WINDOWS_RUNTIME_FILES.filter((name) => name.toLowerCase().endsWith('.dll')),
  WINDOWS_SANDBOX_CLIENT_NAME,
];

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(scriptPath);
const desktopDir = path.resolve(scriptsDir, '..');
const tauriDir = path.join(desktopDir, 'src-tauri');
const defaultReleaseRoot = path.join(tauriDir, 'target', WINDOWS_TARGET, 'release');
const defaultStageDir = path.join(tauriDir, 'target', 'cef-bundle', 'windows');
const expectedArchiveName = cefArchiveSpec(WINDOWS_TARGET).name;
const windowsArchiveSpec = cefArchiveSpec(WINDOWS_TARGET);
export const WINDOWS_CEF_SOURCE_PIN = Object.freeze({
  archiveSha256: windowsArchiveSpec.sha256,
  runtimeFileSetHashAlgorithm: CEF_SOURCE_FILE_SET_HASH_ALGORITHM,
  runtimeFileSetSha256: windowsArchiveSpec.runtimeFileSetSha256,
  runtimeLocaleCount: windowsArchiveSpec.runtimeLocaleCount,
  bootstrapSha256: windowsArchiveSpec.bootstrapSha256,
  creditsSha256: windowsArchiveSpec.creditsSha256,
});

function fail(message) {
  throw new Error(`[cef-windows-stage] ${message}`);
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

async function requireFile(candidate, label) {
  if (await pathType(candidate) !== 'file') fail(`${label} must be a regular file: ${candidate}`);
}

async function requireDirectory(candidate, label) {
  if (await pathType(candidate) !== 'directory') fail(`${label} must be a real directory: ${candidate}`);
}

async function sha256(candidate) {
  return cefFileSha256(candidate);
}

async function readArchiveIdentity(releaseRoot) {
  return readPinnedCefArchiveIdentity(releaseRoot, WINDOWS_TARGET);
}

function exactSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function exactGitSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

function normalizeWindowsSourcePin(value, label = 'Windows CEF source pin') {
  const expectedKeys = [
    'archiveSha256',
    'bootstrapSha256',
    'creditsSha256',
    'runtimeFileSetHashAlgorithm',
    'runtimeFileSetSha256',
    'runtimeLocaleCount',
  ];
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || !exactSha256(value.archiveSha256)
    || !exactSha256(value.bootstrapSha256)
    || !exactSha256(value.creditsSha256)
    || value.runtimeFileSetHashAlgorithm !== CEF_SOURCE_FILE_SET_HASH_ALGORITHM
    || !exactSha256(value.runtimeFileSetSha256)
    || !Number.isSafeInteger(value.runtimeLocaleCount)
    || value.runtimeLocaleCount <= 0
  ) {
    fail(`${label} is incomplete or invalid`);
  }
  return { ...value };
}

export function createWindowsSandboxMarker({
  gitSha,
  cefArchiveName,
  cefArchiveSha1,
  sourcePin = WINDOWS_CEF_SOURCE_PIN,
  unsignedBootstrapSha256,
  unsignedClientLibrarySha256,
  bootstrapCanonicalSha256,
  clientCanonicalSha256,
}) {
  const normalizedSourcePin = normalizeWindowsSourcePin(sourcePin);
  return {
    ...WINDOWS_SANDBOX_MARKER,
    gitSha,
    cefArchiveName,
    cefArchiveSha1,
    cefArchiveSha256: normalizedSourcePin.archiveSha256,
    cefRuntimeFileSetHashAlgorithm: normalizedSourcePin.runtimeFileSetHashAlgorithm,
    cefRuntimeFileSetSha256: normalizedSourcePin.runtimeFileSetSha256,
    cefRuntimeLocaleCount: normalizedSourcePin.runtimeLocaleCount,
    cefCreditsSha256: normalizedSourcePin.creditsSha256,
    unsignedBootstrapSha256,
    unsignedClientLibrarySha256,
    bootstrapCanonicalSha256,
    clientCanonicalSha256,
  };
}

export function validateWindowsSandboxMarker(marker, {
  expectedGitSha,
  cefArchiveName,
  cefArchiveSha1,
  expectedSourcePin = WINDOWS_CEF_SOURCE_PIN,
  unsignedBootstrapSha256,
  unsignedClientLibrarySha256,
  bootstrapCanonicalSha256,
  clientCanonicalSha256,
} = {}) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    fail('Windows sandbox artifact marker must be a JSON object');
  }
  const expectedKeys = [
    ...Object.keys(WINDOWS_SANDBOX_MARKER),
    ...WINDOWS_SANDBOX_MARKER_DYNAMIC_FIELDS,
  ].sort();
  const actualKeys = Object.keys(marker).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail(`Windows sandbox artifact marker fields must be exactly: ${expectedKeys.join(', ')}`);
  }
  for (const [key, expected] of Object.entries(WINDOWS_SANDBOX_MARKER)) {
    if (marker[key] !== expected) {
      fail(`Windows sandbox artifact marker ${key} must equal ${JSON.stringify(expected)}`);
    }
  }
  if (!exactGitSha(marker.gitSha)) fail('Windows sandbox artifact marker gitSha must be an exact commit SHA');
  if (marker.cefArchiveName !== expectedArchiveName) {
    fail(`Windows sandbox artifact marker cefArchiveName must equal ${expectedArchiveName}`);
  }
  if (marker.cefArchiveSha1 !== cefArchiveSpec(WINDOWS_TARGET).sha1) {
    fail('Windows sandbox artifact marker cefArchiveSha1 must match the pinned archive');
  }
  const sourcePin = normalizeWindowsSourcePin(expectedSourcePin, 'expected Windows CEF source pin');
  for (const [field, expected] of [
    ['cefArchiveSha256', sourcePin.archiveSha256],
    ['cefRuntimeFileSetHashAlgorithm', sourcePin.runtimeFileSetHashAlgorithm],
    ['cefRuntimeFileSetSha256', sourcePin.runtimeFileSetSha256],
    ['cefRuntimeLocaleCount', sourcePin.runtimeLocaleCount],
    ['cefCreditsSha256', sourcePin.creditsSha256],
  ]) {
    if (marker[field] !== expected) {
      fail(`Windows sandbox artifact marker ${field} does not match the verified official source`);
    }
  }
  if (!exactSha256(marker.unsignedBootstrapSha256)) {
    fail('Windows sandbox artifact marker unsignedBootstrapSha256 must be an exact SHA-256');
  }
  if (marker.unsignedBootstrapSha256 !== sourcePin.bootstrapSha256) {
    fail('Windows sandbox artifact marker bootstrap does not match the verified official source');
  }
  if (!exactSha256(marker.unsignedClientLibrarySha256)) {
    fail('Windows sandbox artifact marker unsignedClientLibrarySha256 must be an exact SHA-256');
  }
  if (!exactSha256(marker.bootstrapCanonicalSha256)) {
    fail('Windows sandbox artifact marker bootstrapCanonicalSha256 must be an exact SHA-256');
  }
  if (!exactSha256(marker.clientCanonicalSha256)) {
    fail('Windows sandbox artifact marker clientCanonicalSha256 must be an exact SHA-256');
  }
  if (expectedGitSha !== undefined && marker.gitSha !== expectedGitSha) {
    fail(`Windows sandbox artifact marker gitSha must equal ${expectedGitSha}`);
  }
  if (cefArchiveName !== undefined && marker.cefArchiveName !== cefArchiveName) {
    fail('Windows sandbox archive name does not match its current-run marker');
  }
  if (cefArchiveSha1 !== undefined && marker.cefArchiveSha1 !== cefArchiveSha1) {
    fail('Windows sandbox archive SHA-1 does not match its current-run marker');
  }
  if (
    unsignedBootstrapSha256 !== undefined
    && marker.unsignedBootstrapSha256 !== unsignedBootstrapSha256
  ) {
    fail('Windows sandbox bootstrap hash does not match its current-run marker');
  }
  if (
    unsignedClientLibrarySha256 !== undefined
    && marker.unsignedClientLibrarySha256 !== unsignedClientLibrarySha256
  ) {
    fail('Windows sandbox client DLL hash does not match its current-run marker');
  }
  if (
    bootstrapCanonicalSha256 !== undefined
    && marker.bootstrapCanonicalSha256 !== bootstrapCanonicalSha256
  ) {
    fail('Windows sandbox bootstrap canonical hash does not match its current-run marker');
  }
  if (
    clientCanonicalSha256 !== undefined
    && marker.clientCanonicalSha256 !== clientCanonicalSha256
  ) {
    fail('Windows sandbox client DLL canonical hash does not match its current-run marker');
  }
  return { ...marker };
}

async function readSandboxMarker(root, expectations) {
  const candidate = path.join(root, WINDOWS_SANDBOX_MARKER_NAME);
  await requireFile(candidate, 'Windows sandbox artifact marker');
  let marker;
  try {
    marker = JSON.parse(await fsp.readFile(candidate, 'utf8'));
  } catch (error) {
    fail(`Windows sandbox artifact marker is invalid JSON: ${error.message}`);
  }
  return validateWindowsSandboxMarker(marker, expectations);
}

async function localeNames(root) {
  const locales = path.join(root, 'locales');
  await requireDirectory(locales, 'CEF locales');
  const entries = await fsp.readdir(locales, { withFileTypes: true });
  const invalid = entries.filter((entry) => !entry.isFile() || !/^[A-Za-z0-9-]+\.pak$/.test(entry.name));
  if (entries.length === 0 || invalid.length > 0) {
    fail(`CEF locales must contain only locale .pak files: ${invalid.map(({ name }) => name).join(', ')}`);
  }
  const names = entries.map(({ name }) => name).sort();
  if (!names.includes('en-US.pak')) {
    fail('CEF locales must include en-US.pak');
  }
  return names;
}

export async function inspectOfficialWindowsCefSource(root, {
  expectedSourcePin = WINDOWS_CEF_SOURCE_PIN,
} = {}) {
  const sourcePin = normalizeWindowsSourcePin(expectedSourcePin, 'expected Windows CEF source pin');
  await requireDirectory(root, 'Windows CEF release root');
  const archive = await readArchiveIdentity(root);
  const legal = await inspectCefArchiveLegalSource(root, WINDOWS_TARGET);
  if (legal.creditsSha256 !== sourcePin.creditsSha256) {
    fail('CEF CREDITS.html does not match the verified official Windows archive');
  }
  for (const name of WINDOWS_RUNTIME_FILES) await requireFile(path.join(root, name), name);
  await requireFile(
    path.join(root, WINDOWS_SOURCE_BOOTSTRAP_NAME),
    'official CEF bootstrap',
  );
  const locales = await localeNames(root);
  if (locales.length !== sourcePin.runtimeLocaleCount) {
    fail(`CEF locale count must equal the verified official archive count ${sourcePin.runtimeLocaleCount}`);
  }
  const runtimeFileSetSha256 = await cefFileSetSha256(root, [
    ...WINDOWS_RUNTIME_FILES,
    ...locales.map((name) => `locales/${name}`),
  ]);
  if (runtimeFileSetSha256 !== sourcePin.runtimeFileSetSha256) {
    fail('CEF runtime file set does not match the verified official Windows archive');
  }
  const bootstrapSha256 = await sha256(path.join(root, WINDOWS_SOURCE_BOOTSTRAP_NAME));
  if (bootstrapSha256 !== sourcePin.bootstrapSha256) {
    fail('CEF bootstrap does not match the verified official Windows archive');
  }
  return {
    archive,
    legal,
    locales,
    sourcePin: {
      ...sourcePin,
      runtimeFileSetSha256,
      bootstrapSha256,
      creditsSha256: legal.creditsSha256,
    },
  };
}

export async function inspectWindowsRuntime(root, {
  sandboxRoot,
  expectedGitSha,
  expectedSourcePin = WINDOWS_CEF_SOURCE_PIN,
} = {}) {
  if (!sandboxRoot) fail('a separate current-run Windows sandbox provenance root is required');
  await requireDirectory(sandboxRoot, 'current-run Windows sandbox provenance root');
  const source = await inspectOfficialWindowsCefSource(root, { expectedSourcePin });
  const { archive, legal, locales, sourcePin } = source;
  for (const name of [WINDOWS_SOURCE_BOOTSTRAP_NAME, WINDOWS_SANDBOX_CLIENT_NAME]) {
    await requireFile(path.join(sandboxRoot, name), name);
  }
  const unsignedBootstrapSha256 = await sha256(path.join(sandboxRoot, WINDOWS_SOURCE_BOOTSTRAP_NAME));
  if (unsignedBootstrapSha256 !== sourcePin.bootstrapSha256) {
    fail('current-run sandbox bootstrap does not match the verified official Windows archive');
  }
  const unsignedClientLibrarySha256 = await sha256(path.join(sandboxRoot, WINDOWS_SANDBOX_CLIENT_NAME));
  const bootstrapCanonicalSha256 = await canonicalPeFileSha256(
    path.join(sandboxRoot, WINDOWS_SOURCE_BOOTSTRAP_NAME),
  );
  const clientCanonicalSha256 = await canonicalPeFileSha256(
    path.join(sandboxRoot, WINDOWS_SANDBOX_CLIENT_NAME),
  );
  const sandbox = await readSandboxMarker(sandboxRoot, {
    expectedGitSha,
    cefArchiveName: archive.name,
    cefArchiveSha1: archive.sha1,
    expectedSourcePin: sourcePin,
    unsignedBootstrapSha256,
    unsignedClientLibrarySha256,
    bootstrapCanonicalSha256,
    clientCanonicalSha256,
  });
  const legalFiles = CEF_LEGAL_FILES.map((name) => `${CEF_LEGAL_DIRECTORY}/${name}`);
  const files = [
    ...WINDOWS_STAGE_FILES,
    ...locales.map((name) => `locales/${name}`),
    ...legalFiles,
  ];
  const hashes = {};
  for (const relative of files) {
    let sourceRoot = root;
    let source = relative;
    if ([WINDOWS_SANDBOX_CLIENT_NAME, WINDOWS_SANDBOX_MARKER_NAME].includes(relative)) {
      sourceRoot = sandboxRoot;
    }
    if (relative === `${CEF_LEGAL_DIRECTORY}/LICENSE.txt`) {
      sourceRoot = path.dirname(CEF_LICENSE_SOURCE_PATH);
      source = path.basename(CEF_LICENSE_SOURCE_PATH);
    }
    if (relative === `${CEF_LEGAL_DIRECTORY}/CREDITS.html`) source = 'CREDITS.html';
    hashes[relative] = await sha256(path.join(sourceRoot, ...source.split('/')));
  }
  return {
    archive,
    legal,
    sourcePin,
    sandbox,
    sandboxRoot,
    files,
    hashes,
    locales,
  };
}

async function inspectStagedWindowsRuntime(root, expectedGitSha, expectedSourcePin) {
  await requireDirectory(root, 'staged Windows CEF runtime');
  for (const name of WINDOWS_STAGE_FILES) await requireFile(path.join(root, name), name);
  await requireFile(path.join(root, WINDOWS_SOURCE_BOOTSTRAP_NAME), 'official CEF bootstrap');
  const sandbox = await readSandboxMarker(root, {
    expectedGitSha,
    expectedSourcePin,
    bootstrapCanonicalSha256: await canonicalPeFileSha256(
      path.join(root, WINDOWS_SOURCE_BOOTSTRAP_NAME),
    ),
    clientCanonicalSha256: await canonicalPeFileSha256(
      path.join(root, WINDOWS_SANDBOX_CLIENT_NAME),
    ),
  });
  const locales = await localeNames(root);
  if (locales.length !== expectedSourcePin.runtimeLocaleCount) {
    fail('staged CEF locale count does not match the verified official source');
  }
  const legal = await inspectStagedCefLegalFiles(root, WINDOWS_TARGET, null, {
    expectedCreditsSha256: expectedSourcePin.creditsSha256,
  });
  const files = [
    ...WINDOWS_STAGE_FILES,
    ...locales.map((name) => `locales/${name}`),
    ...CEF_LEGAL_FILES.map((name) => `${CEF_LEGAL_DIRECTORY}/${name}`),
  ];
  const hashes = {};
  for (const relative of files) hashes[relative] = await sha256(path.join(root, ...relative.split('/')));
  return { sandbox, files, hashes, locales, legal };
}

function signArgs(signing, target) {
  return [
    'sign',
    '/fd', 'SHA256',
    '/td', 'SHA256',
    '/tr', signing.timestampUrl,
    '/sha1', signing.thumbprint,
    target,
  ];
}

export function createWindowsSigningPlan({ stageDir, signing, signtoolPath }) {
  const targets = WINDOWS_SIGNED_RESOURCE_FILES.map((name) => path.join(stageDir, name));
  return {
    removeExisting: targets.map((target) => ({
      program: signtoolPath,
      args: ['remove', '/s', target],
    })),
    sign: targets.map((target) => ({ program: signtoolPath, args: signArgs(signing, target) })),
    verify: targets.map((target) => ({
      program: signtoolPath,
      args: ['verify', '/pa', '/all', '/v', target],
    })),
    targets,
  };
}

export function createWindowsSandboxInspectionPlan({ sandboxRoot, dumpbinPath }) {
  return {
    program: dumpbinPath,
    args: ['/nologo', '/exports', path.join(sandboxRoot, WINDOWS_SANDBOX_CLIENT_NAME)],
  };
}

export function createWindowsSandboxHeadersInspectionPlan({ sandboxRoot, dumpbinPath }) {
  return [WINDOWS_SOURCE_BOOTSTRAP_NAME, WINDOWS_SANDBOX_CLIENT_NAME].map((name) => ({
    program: dumpbinPath,
    args: ['/nologo', '/headers', path.join(sandboxRoot, name)],
  }));
}

export function assertRunWinMainExport(output) {
  const hasExactExport = output.split(/\r?\n/u).some((line) => {
    const columns = line.trim().split(/\s+/u);
    return columns.includes(WINDOWS_SANDBOX_ENTRY_POINT);
  });
  if (!hasExactExport) {
    fail(`sandbox client DLL does not export exact ${WINDOWS_SANDBOX_ENTRY_POINT}`);
  }
}

export function assertX64PeHeaders(output) {
  if (!output.split(/\r?\n/u).some((line) => /\b8664 machine \(x64\)/iu.test(line))) {
    fail('sandbox bootstrap/client is not an x64 PE image');
  }
}

function runCommand(command) {
  const result = spawnSync(command.program, command.args, {
    cwd: desktopDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) fail(`cannot execute ${command.program}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command.program} ${command.args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function resolveSigntool(environment = process.env) {
  const configured = environment.CCEM_SIGNTOOL_PATH;
  if (!configured || !path.win32.isAbsolute(configured)) {
    fail('CCEM_SIGNTOOL_PATH must be an absolute Windows SDK signtool.exe path');
  }
  const normalized = path.win32.normalize(configured);
  if (
    path.win32.basename(normalized).toLowerCase() !== 'signtool.exe'
    || !/^C:\\Program Files \(x86\)\\Windows Kits\\10\\bin\\[^\\]+\\x64\\signtool\.exe$/i.test(normalized)
  ) {
    fail('CCEM_SIGNTOOL_PATH is outside the pinned Windows SDK x64 tool boundary');
  }
  return normalized;
}

function resolveDumpbin(environment = process.env) {
  const configured = environment.CCEM_DUMPBIN_PATH;
  if (!configured || !path.win32.isAbsolute(configured)) {
    fail('CCEM_DUMPBIN_PATH must be an absolute Visual Studio dumpbin.exe path');
  }
  const normalized = path.win32.normalize(configured);
  if (
    path.win32.basename(normalized).toLowerCase() !== 'dumpbin.exe'
    || !/^C:\\Program Files(?: \(x86\))?\\Microsoft Visual Studio\\2022\\[^\\]+\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64\\dumpbin\.exe$/iu.test(normalized)
  ) {
    fail('CCEM_DUMPBIN_PATH is outside the pinned Visual Studio 2022 x64 tool boundary');
  }
  return normalized;
}

function assertCiAuthorization() {
  if (
    process.env.GITHUB_ACTIONS !== 'true'
    || process.env.RUNNER_OS !== 'Windows'
    || process.env.CCEM_CEF_ALLOW_SIGNTOOL !== '1'
    || process.platform !== 'win32'
  ) {
    fail('actual Windows CEF signing is allowed only on an explicitly authorized GitHub Actions Windows runner');
  }
}

function requireEnvironment(environment, name, pattern) {
  const value = environment[name]?.trim();
  if (!value || (pattern && !pattern.test(value))) {
    fail(`${name} is missing or invalid for current-run Windows sandbox provenance`);
  }
  return value;
}

function assertCurrentRunSandboxRoot(sandboxRoot, environment = process.env) {
  const runnerTemp = requireEnvironment(environment, 'RUNNER_TEMP');
  const runId = requireEnvironment(environment, 'GITHUB_RUN_ID', /^\d+$/u);
  const runAttempt = requireEnvironment(environment, 'GITHUB_RUN_ATTEMPT', /^\d+$/u);
  const expected = path.resolve(
    runnerTemp,
    'ccem-cef-sandbox',
    `${runId}-${runAttempt}`,
    WINDOWS_TARGET,
  );
  if (path.resolve(sandboxRoot) !== expected) {
    fail(`sandbox provenance root must be the isolated current-run path ${expected}`);
  }
  return { runId, runAttempt, source: 'runner-temp-current-run' };
}

function powershellEncoded(source) {
  return Buffer.from(source, 'utf16le').toString('base64');
}

function inspectSignature(candidate) {
  const escaped = candidate.replaceAll("'", "''");
  const command = {
    program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      powershellEncoded([
        `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
        '[PSCustomObject]@{',
        '  Status = [string]$signature.Status',
        '  Thumbprint = $signature.SignerCertificate.Thumbprint',
        '  Subject = $signature.SignerCertificate.Subject',
        '  Timestamp = $signature.TimeStamperCertificate.Thumbprint',
        '} | ConvertTo-Json -Compress',
      ].join('\n')),
    ],
  };
  try {
    return JSON.parse(runCommand(command).trim());
  } catch (error) {
    fail(`cannot inspect staged Authenticode signature for ${candidate}: ${error.message}`);
  }
}

async function copyStage(releaseRoot, sandboxRoot, stageDir, inspected) {
  const parent = path.dirname(stageDir);
  const temporary = path.join(parent, `.${path.basename(stageDir)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  await fsp.rm(temporary, { recursive: true, force: true });
  await fsp.mkdir(path.join(temporary, 'locales'), { recursive: true });
  try {
    for (const name of WINDOWS_RUNTIME_FILES) {
      await fsp.copyFile(path.join(releaseRoot, name), path.join(temporary, name));
    }
    await fsp.copyFile(
      path.join(sandboxRoot, WINDOWS_SOURCE_BOOTSTRAP_NAME),
      path.join(temporary, WINDOWS_SOURCE_BOOTSTRAP_NAME),
    );
    for (const name of [WINDOWS_SANDBOX_CLIENT_NAME, WINDOWS_SANDBOX_MARKER_NAME]) {
      await fsp.copyFile(path.join(sandboxRoot, name), path.join(temporary, name));
    }
    for (const locale of inspected.locales) {
      await fsp.copyFile(
        path.join(releaseRoot, 'locales', locale),
        path.join(temporary, 'locales', locale),
      );
    }
    await stageCefLegalFiles({
      runtimeRoot: releaseRoot,
      outputRoot: temporary,
      target: WINDOWS_TARGET,
    });
    const expectedTopLevel = [
      ...WINDOWS_STAGE_FILES,
      WINDOWS_SOURCE_BOOTSTRAP_NAME,
      'locales',
      'third-party',
    ].sort();
    const actualTopLevel = (await fsp.readdir(temporary)).sort();
    if (JSON.stringify(actualTopLevel) !== JSON.stringify(expectedTopLevel)) {
      fail('copied unsigned Windows CEF stage contains an unexpected top-level member');
    }
    for (const relative of inspected.files) {
      const copiedHash = await sha256(path.join(temporary, ...relative.split('/')));
      if (copiedHash !== inspected.hashes[relative]) {
        fail(`copied unsigned Windows CEF member changed during staging: ${relative}`);
      }
    }
    if (
      await sha256(path.join(temporary, WINDOWS_SOURCE_BOOTSTRAP_NAME))
      !== inspected.sourcePin.bootstrapSha256
    ) {
      fail('copied unsigned Windows CEF bootstrap changed during staging');
    }
    const copiedRuntimeFileSetSha256 = await cefFileSetSha256(temporary, [
      ...WINDOWS_RUNTIME_FILES,
      ...inspected.locales.map((name) => `locales/${name}`),
    ]);
    if (copiedRuntimeFileSetSha256 !== inspected.sourcePin.runtimeFileSetSha256) {
      fail('copied unsigned Windows CEF runtime file set changed during staging');
    }
    const backup = `${stageDir}.old-${process.pid}-${randomBytes(4).toString('hex')}`;
    const hadStage = await pathType(stageDir) === 'directory';
    if (hadStage) await fsp.rename(stageDir, backup);
    try {
      await fsp.rename(temporary, stageDir);
    } catch (error) {
      if (hadStage && await pathType(backup) === 'directory') await fsp.rename(backup, stageDir);
      throw error;
    }
    if (hadStage) await fsp.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function writeManifest(stageDir, value) {
  const target = path.join(stageDir, WINDOWS_STAGE_MANIFEST);
  const temporary = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, target);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    releaseRoot: defaultReleaseRoot,
    sandboxRoot: null,
    stageDir: defaultStageDir,
    target: WINDOWS_TARGET,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (['--release-root', '--sandbox-root', '--output', '--target'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      index += 1;
      if (argument === '--release-root') options.releaseRoot = path.resolve(value);
      if (argument === '--sandbox-root') options.sandboxRoot = path.resolve(value);
      if (argument === '--output') options.stageDir = path.resolve(value);
      if (argument === '--target') options.target = value;
    } else if (argument === '--help') options.help = true;
    else fail(`unknown argument: ${argument}`);
  }
  return options;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node scripts/stage-cef-windows.mjs [--dry-run] --release-root <dir> --sandbox-root <current-run-dir> [--output <dir>] --target x86_64-pc-windows-msvc\n');
    return { status: 'help' };
  }
  if (options.target !== WINDOWS_TARGET) fail(`unsupported Windows Mode 2 target ${options.target}`);
  if (!options.sandboxRoot) fail('--sandbox-root is required; target cache is never a sandbox provenance source');
  const gitSha = requireEnvironment(process.env, 'GITHUB_SHA', /^[a-f0-9]{40}$/u);
  const provenance = options.dryRun ? null : assertCurrentRunSandboxRoot(options.sandboxRoot);
  const signing = validateWindowsReleaseSigning();
  const runtime = await inspectWindowsRuntime(options.releaseRoot, {
    sandboxRoot: options.sandboxRoot,
    expectedGitSha: gitSha,
  });
  const signtoolPath = options.dryRun
    ? (process.env.CCEM_SIGNTOOL_PATH || 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\<sdk>\\x64\\signtool.exe')
    : resolveSigntool();
  const dumpbinPath = options.dryRun
    ? (process.env.CCEM_DUMPBIN_PATH || 'C:\\Program Files\\Microsoft Visual Studio\\2022\\<edition>\\VC\\Tools\\MSVC\\<version>\\bin\\Hostx64\\x64\\dumpbin.exe')
    : resolveDumpbin();
  const plan = {
    inspectSandboxExports: createWindowsSandboxInspectionPlan({
      sandboxRoot: options.sandboxRoot,
      dumpbinPath,
    }),
    inspectSandboxHeaders: createWindowsSandboxHeadersInspectionPlan({
      sandboxRoot: options.sandboxRoot,
      dumpbinPath,
    }),
    ...createWindowsSigningPlan({ stageDir: options.stageDir, signing, signtoolPath }),
  };
  if (options.dryRun) {
    const output = {
      target: options.target,
      releaseRoot: options.releaseRoot,
      sandboxRoot: options.sandboxRoot,
      sourceCommit: gitSha,
      stageDir: options.stageDir,
      cefRuntimeVersion: CEF_FULL_VERSION,
      runtimeFiles: runtime.files,
      plan,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return { status: 'dry-run', plan };
  }

  assertCiAuthorization();
  assertRunWinMainExport(runCommand(plan.inspectSandboxExports));
  for (const command of plan.inspectSandboxHeaders) assertX64PeHeaders(runCommand(command));
  await copyStage(options.releaseRoot, options.sandboxRoot, options.stageDir, runtime);
  await readSandboxMarker(options.stageDir, {
    expectedGitSha: gitSha,
    cefArchiveName: runtime.archive.name,
    cefArchiveSha1: runtime.archive.sha1,
    expectedSourcePin: runtime.sourcePin,
    unsignedBootstrapSha256: await sha256(
      path.join(options.stageDir, WINDOWS_SOURCE_BOOTSTRAP_NAME),
    ),
    unsignedClientLibrarySha256: await sha256(
      path.join(options.stageDir, WINDOWS_SANDBOX_CLIENT_NAME),
    ),
    bootstrapCanonicalSha256: await canonicalPeFileSha256(
      path.join(options.stageDir, WINDOWS_SOURCE_BOOTSTRAP_NAME),
    ),
    clientCanonicalSha256: await canonicalPeFileSha256(
      path.join(options.stageDir, WINDOWS_SANDBOX_CLIENT_NAME),
    ),
  });
  const actualPlan = createWindowsSigningPlan({ stageDir: options.stageDir, signing, signtoolPath });
  for (let index = 0; index < actualPlan.targets.length; index += 1) {
    const existing = inspectSignature(actualPlan.targets[index]);
    if (existing.Status !== 'NotSigned') {
      runCommand(actualPlan.removeExisting[index]);
      if (inspectSignature(actualPlan.targets[index]).Status !== 'NotSigned') {
        fail(`could not remove existing Authenticode signatures: ${actualPlan.targets[index]}`);
      }
    }
  }
  for (const command of actualPlan.sign) runCommand(command);
  for (const command of actualPlan.verify) runCommand(command);
  for (const candidate of actualPlan.targets) {
    const signature = inspectSignature(candidate);
    if (
      signature.Status !== 'Valid'
      || signature.Thumbprint?.replaceAll(/\s/g, '').toUpperCase() !== signing.thumbprint
      || signature.Subject !== signing.publisher
      || !signature.Timestamp
    ) {
      fail(`staged sandbox artifact is not exactly trusted and timestamped: ${candidate}`);
    }
  }
  const staged = await inspectStagedWindowsRuntime(options.stageDir, gitSha, runtime.sourcePin);
  const manifest = {
    schemaVersion: 4,
    target: options.target,
    profile: 'release',
    sourceCommit: gitSha,
    cefRuntimeVersion: CEF_FULL_VERSION,
    archive: runtime.archive,
    sourcePin: runtime.sourcePin,
    legal: staged.legal,
    sandbox: staged.sandbox,
    provenance,
    signer: {
      thumbprint: signing.thumbprint,
      publisher: signing.publisher,
      timestamped: true,
      signedFiles: WINDOWS_SIGNED_RESOURCE_FILES,
    },
    files: staged.files,
    hashes: staged.hashes,
  };
  await writeManifest(options.stageDir, manifest);
  process.stdout.write(`[cef-windows-stage] staged and signed ${staged.files.length} pinned CEF members\n`);
  return { status: 'staged-and-signed', manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
