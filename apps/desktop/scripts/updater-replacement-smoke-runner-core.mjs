import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  UPDATER_REPLACEMENT_CLOCK,
  createUpdaterReplacementProcessIdentityFingerprint,
  hashUpdaterReplacementSmokeJson,
  sealUpdaterReplacementStageReceipt,
} from './updater-replacement-smoke-contract.mjs';

const execFileAsync = promisify(execFile);
const FIRST_RECEIPT_SHA256 = '0'.repeat(64);
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

export const UPDATER_REPLACEMENT_SMOKE_ALLOW_ENV =
  'CCEM_UPDATER_REPLACEMENT_SMOKE_ALLOW';

const COMMON_CHILD_ENVIRONMENT = Object.freeze([
  'GITHUB_ACTIONS',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_SHA',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'RUNNER_OS',
  'RUNNER_TEMP',
]);

const MACOS_CHILD_ENVIRONMENT = Object.freeze([
  'HOME',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'USER',
  '__CF_USER_TEXT_ENCODING',
]);

const WINDOWS_CHILD_ENVIRONMENT = Object.freeze([
  'APPDATA',
  'COMSPEC',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
]);

const FORBIDDEN_CHILD_ENVIRONMENT = Object.freeze([
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY',
  'APPLE_API_KEY_PATH',
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'CCEM_GITHUB_SETTINGS_TOKEN',
  'GITHUB_TOKEN',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'WINDOWS_CERTIFICATE',
  'WINDOWS_CERTIFICATE_PASSWORD',
]);

function fail(message) {
  throw new Error(`[updater-replacement-smoke-runner] ${message}`);
}

function stripWindowsExtendedPathPrefix(value) {
  const normalized = value.replaceAll('/', '\\');
  const folded = normalized.toLowerCase();
  if (folded.startsWith('\\\\?\\unc\\')) return `\\\\${normalized.slice(8)}`;
  if (folded.startsWith('\\\\?\\') || folded.startsWith('\\??\\')) {
    return normalized.slice(4);
  }
  return normalized;
}

export function updaterReplacementPathForEvidence(candidate, platform = process.platform) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
    fail('process path identity must be non-empty text without NUL');
  }
  if (platform === 'win32' || platform === 'windows') {
    return path.win32.normalize(stripWindowsExtendedPathPrefix(candidate));
  }
  if (platform === 'darwin' || platform === 'macos') return path.posix.normalize(candidate);
  fail('process path identity is supported only on macOS and Windows');
}

export function updaterReplacementPathsEqual(left, right, platform = process.platform) {
  const leftIdentity = updaterReplacementPathForEvidence(left, platform);
  const rightIdentity = updaterReplacementPathForEvidence(right, platform);
  return platform === 'win32' || platform === 'windows'
    ? leftIdentity.toLowerCase() === rightIdentity.toLowerCase()
    : leftIdentity === rightIdentity;
}

export function updaterReplacementPathIsInside(candidate, root, platform = process.platform) {
  const implementation = platform === 'win32' || platform === 'windows'
    ? path.win32
    : path.posix;
  const normalizedCandidate = updaterReplacementPathForEvidence(candidate, platform);
  const normalizedRoot = updaterReplacementPathForEvidence(root, platform);
  const left = platform === 'win32' || platform === 'windows'
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  const right = platform === 'win32' || platform === 'windows'
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
  const relative = implementation.relative(right, left);
  return relative === '' || (!relative.startsWith('..') && !implementation.isAbsolute(relative));
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

function exactPositiveDecimal(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) {
    fail(`${label} must be a positive decimal string`);
  }
  return value;
}

function exactLowerHex(value, length, label) {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value)) {
    fail(`${label} must be exact lowercase hex`);
  }
  return value;
}

export function assertUpdaterReplacementSmokeAuthorization(
  environment = process.env,
  platform = process.platform,
) {
  const expectedRunner = platform === 'darwin'
    ? 'macOS'
    : platform === 'win32'
      ? 'Windows'
      : null;
  if (
    expectedRunner === null
    || environment.GITHUB_ACTIONS !== 'true'
    || environment.CI !== 'true'
    || environment.RUNNER_OS !== expectedRunner
    || environment[UPDATER_REPLACEMENT_SMOKE_ALLOW_ENV] !== '1'
  ) {
    fail('real replacement smoke requires its explicit GitHub Actions platform gate');
  }
  exactPositiveDecimal(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID');
  exactPositiveDecimal(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT');
  exactLowerHex(environment.GITHUB_SHA, 40, 'GITHUB_SHA');
  return expectedRunner;
}

export function createUpdaterReplacementChildEnvironment(
  environment,
  overrides,
  platform,
) {
  if (!['darwin', 'win32'].includes(platform)) fail('child platform must be darwin or win32');
  const allowed = new Set([
    ...COMMON_CHILD_ENVIRONMENT,
    ...(platform === 'darwin' ? MACOS_CHILD_ENVIRONMENT : WINDOWS_CHILD_ENVIRONMENT),
  ].map((name) => name.toUpperCase()));
  const clean = {};
  for (const [name, value] of Object.entries(environment)) {
    if (allowed.has(name.toUpperCase()) && typeof value === 'string') clean[name] = value;
  }
  for (const name of FORBIDDEN_CHILD_ENVIRONMENT) {
    for (const candidate of Object.keys(clean)) {
      if (candidate.toUpperCase() === name) delete clean[candidate];
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (FORBIDDEN_CHILD_ENVIRONMENT.includes(name.toUpperCase())) {
      fail(`refusing to pass forbidden child environment ${name}`);
    }
    if (typeof value !== 'string') fail(`child environment ${name} must be a string`);
    clean[name] = value;
  }
  return clean;
}

export async function sha256File(candidate) {
  const exact = path.resolve(candidate);
  const metadata = await fsp.lstat(exact).catch((error) => {
    fail(`inspect file ${exact}: ${error.message}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`file must be a regular non-link: ${exact}`);
  }
  const hash = createHash('sha256');
  const input = fs.createReadStream(exact);
  await new Promise((resolve, reject) => {
    input.once('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('end', resolve);
  });
  return hash.digest('hex');
}

export async function readRegularJson(candidate, label = 'JSON evidence') {
  const exact = path.resolve(candidate);
  const metadata = await fsp.lstat(exact).catch((error) => {
    fail(`${label} is missing: ${error.message}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JSON_BYTES) {
    fail(`${label} must be a bounded regular non-link file`);
  }
  const handle = await fsp.open(exact, 'r');
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size > MAX_JSON_BYTES
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
    ) {
      fail(`${label} changed identity or exceeds the JSON size bound`);
    }
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (bytes.length !== opened.size || final.size !== opened.size) {
      fail(`${label} changed while it was being consumed`);
    }
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (String(error.message).startsWith('[updater-replacement-smoke-runner]')) throw error;
    fail(`${label} is invalid JSON: ${error.message}`);
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function writePrivateJsonCreateNew(candidate, value) {
  const exact = path.resolve(candidate);
  await fsp.writeFile(exact, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

export async function waitForRegularJson(
  candidate,
  { label = 'smoke handoff', timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readRegularJson(candidate, label);
    } catch (error) {
      if (!String(error.message).includes('is missing:')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  fail(`timed out waiting for ${label}: ${candidate}`);
}

function safeRelativePath(value, label) {
  if (
    value.length === 0
    || value.includes('\\')
    || value.startsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    fail(`${label} is not a normalized forward-slash relative path`);
  }
  return value;
}

function compareEntry(left, right) {
  return left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;
}

async function visitTree(root, current, entries, unsafe) {
  const children = await fsp.readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const child of children) {
    const absolutePath = path.join(current, child.name);
    const relativePath = safeRelativePath(
      path.relative(root, absolutePath).split(path.sep).join('/'),
      'install-tree entry',
    );
    const metadata = await fsp.lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      entries.push({ relativePath, type: 'link' });
      unsafe.linkPaths.push(relativePath);
    } else if (metadata.isDirectory()) {
      entries.push({ relativePath, type: 'directory' });
      await visitTree(root, absolutePath, entries, unsafe);
    } else if (metadata.isFile()) {
      entries.push({
        relativePath,
        type: 'file',
        size: metadata.size,
        sha256: await sha256File(absolutePath),
      });
    } else {
      entries.push({ relativePath, type: 'unsupported' });
      unsafe.unsupportedEntries.push(relativePath);
    }
  }
}

export async function scanNoFollowTree(root) {
  const exactRoot = path.resolve(root);
  const metadata = await fsp.lstat(exactRoot).catch((error) => {
    fail(`inspect tree root ${exactRoot}: ${error.message}`);
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`tree root must be a non-link directory: ${exactRoot}`);
  }
  const entries = [];
  const unsafe = { linkPaths: [], unsupportedEntries: [] };
  await visitTree(exactRoot, exactRoot, entries, unsafe);
  entries.sort(compareEntry);
  unsafe.linkPaths.sort();
  unsafe.unsupportedEntries.sort();
  return {
    root: exactRoot,
    entries,
    pathCount: entries.length,
    treeSha256: hashUpdaterReplacementSmokeJson(entries),
    ...unsafe,
  };
}

export function regularFileInventoryFromTree(tree) {
  const files = {};
  for (const entry of tree.entries) {
    if (entry.type === 'file') files[entry.relativePath] = entry.sha256;
  }
  return files;
}

export function systemBootMonotonicMs() {
  return Math.floor(os.uptime() * 1_000);
}

async function observeMacosProcess(pid) {
  const { stdout } = await execFileAsync('/bin/ps', [
    '-p', String(pid), '-o', 'pid=,ppid=,lstart=,comm=',
  ], { maxBuffer: 1024 * 1024 });
  const match = stdout.trim().match(
    /^(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u,
  );
  if (!match || Number(match[1]) !== pid) fail(`cannot independently observe process ${pid}`);
  return {
    pid,
    parentPid: Number(match[2]),
    osStartToken: `darwin:${match[3].replaceAll(/\s+/gu, ' ')}`,
    canonicalImagePath: await fsp.realpath(match[4]),
  };
}

const WINDOWS_PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$p = Get-CimInstance Win32_Process -Filter "ProcessId = $($args[0])"
if ($null -eq $p) { throw "missing process" }
[ordered]@{
  pid = [int]$p.ProcessId
  parentPid = [int]$p.ParentProcessId
  osStartToken = "windows:$($p.CreationDate.ToUniversalTime().ToString('o'))"
  canonicalImagePath = [System.IO.Path]::GetFullPath($p.ExecutablePath)
} | ConvertTo-Json -Compress
`;

async function observeWindowsProcess(pid) {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCRIPT, String(pid),
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function observeProcessIdentity({
  pid,
  boot,
  platform = process.platform,
}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || boot.pid !== pid) {
    fail('process observation PID does not match the boot record');
  }
  const observed = platform === 'darwin'
    ? await observeMacosProcess(pid)
    : platform === 'win32'
      ? await observeWindowsProcess(pid)
      : fail('process observation is supported only on macOS and Windows');
  const canonicalImagePath = updaterReplacementPathForEvidence(
    await fsp.realpath(boot.canonicalImagePath),
    platform,
  );
  if (!updaterReplacementPathsEqual(observed.canonicalImagePath, canonicalImagePath, platform)) {
    fail('OS-observed process image does not match the boot record');
  }
  const imageSha256 = await sha256File(canonicalImagePath);
  if (imageSha256 !== boot.imageSha256) fail('OS-observed process image digest mismatch');
  const identity = {
    pid,
    osStartToken: observed.osStartToken,
    canonicalImagePath,
    imageSha256,
    runtimeVersion: boot.runtimeVersion,
    embeddedSourceCommit: boot.embeddedSourceCommit,
    challengeNonce: boot.challengeNonce,
  };
  return {
    ...identity,
    parentPid: observed.parentPid,
    processIdentitySha256: createUpdaterReplacementProcessIdentityFingerprint(identity),
  };
}

export async function createHarnessProcessIdentity({ sourceCommit, challengeNonce }) {
  const canonicalImagePath = updaterReplacementPathForEvidence(
    await fsp.realpath(process.execPath),
    process.platform,
  );
  const observed = process.platform === 'darwin'
    ? await observeMacosProcess(process.pid)
    : process.platform === 'win32'
      ? await observeWindowsProcess(process.pid)
      : fail('harness process identity is supported only on macOS and Windows');
  if (!updaterReplacementPathsEqual(
    observed.canonicalImagePath,
    canonicalImagePath,
    process.platform,
  )) {
    fail('OS-observed harness image does not match process.execPath');
  }
  const identity = {
    pid: process.pid,
    osStartToken: observed.osStartToken,
    canonicalImagePath,
    imageSha256: await sha256File(canonicalImagePath),
    runtimeVersion: process.versions.node,
    embeddedSourceCommit: exactLowerHex(sourceCommit, 40, 'harness source commit'),
    challengeNonce: exactLowerHex(challengeNonce, 64, 'challenge nonce'),
  };
  return {
    ...identity,
    processIdentitySha256: createUpdaterReplacementProcessIdentityFingerprint(identity),
  };
}

export async function readAndVerifyStage(sharedRoot, sequence, name) {
  const detailPath = path.join(sharedRoot, `stage-${String(sequence).padStart(2, '0')}-${name}.detail.json`);
  const receiptPath = path.join(sharedRoot, `stage-${String(sequence).padStart(2, '0')}-${name}.json`);
  const [detail, receipt] = await Promise.all([
    waitForRegularJson(detailPath, { label: `${name} stage detail` }),
    waitForRegularJson(receiptPath, { label: `${name} stage receipt` }),
  ]);
  if (receipt.evidenceSha256 !== hashUpdaterReplacementSmokeJson(detail)) {
    fail(`${name} stage receipt does not hash its independently retained detail`);
  }
  const sealed = sealUpdaterReplacementStageReceipt({
    name: receipt.name,
    sequence: receipt.sequence,
    actor: receipt.actor,
    processIdentitySha256: receipt.processIdentitySha256,
    clock: receipt.clock,
    bootMonotonicMs: receipt.bootMonotonicMs,
    wallClockUtc: receipt.wallClockUtc,
    evidenceSha256: receipt.evidenceSha256,
    contextSha256: receipt.contextSha256,
    previousReceiptSha256: receipt.previousReceiptSha256,
  });
  if (JSON.stringify(sealed) !== JSON.stringify(receipt)) {
    fail(`${name} stage receipt seal is invalid`);
  }
  return { detail, receipt };
}

export async function writeHarnessStage({
  sharedRoot,
  sequence,
  name,
  identity,
  contextSha256,
  detail,
  previousReceipt,
}) {
  const evidenceSha256 = hashUpdaterReplacementSmokeJson(detail);
  const receipt = sealUpdaterReplacementStageReceipt({
    name,
    sequence,
    actor: 'harness',
    processIdentitySha256: identity.processIdentitySha256,
    clock: UPDATER_REPLACEMENT_CLOCK,
    bootMonotonicMs: Math.max(
      systemBootMonotonicMs(),
      (previousReceipt?.bootMonotonicMs ?? -1) + 1,
    ),
    wallClockUtc: new Date(Math.max(
      Date.now(),
      previousReceipt ? Date.parse(previousReceipt.wallClockUtc) + 1 : 0,
    )).toISOString(),
    evidenceSha256,
    contextSha256,
    previousReceiptSha256: previousReceipt?.receiptSha256 ?? FIRST_RECEIPT_SHA256,
  });
  const prefix = `stage-${String(sequence).padStart(2, '0')}-${name}`;
  await writePrivateJsonCreateNew(path.join(sharedRoot, `${prefix}.detail.json`), detail);
  await writePrivateJsonCreateNew(path.join(sharedRoot, `${prefix}.json`), receipt);
  return receipt;
}

export function spawnObserved(program, args, options) {
  return spawn(program, args, {
    cwd: options.cwd,
    env: options.environment,
    detached: false,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function waitForChildExit(child, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`process ${child.pid} timed out`));
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

export function assertNoForbiddenChildEnvironment(environment) {
  const names = new Set(Object.keys(environment).map((name) => name.toUpperCase()));
  const leaked = FORBIDDEN_CHILD_ENVIRONMENT.filter((name) => names.has(name));
  if (leaked.length > 0) fail(`child environment leaked release credentials: ${leaked.join(', ')}`);
  return true;
}

export const updaterReplacementSmokeRunnerInternals = Object.freeze({
  FORBIDDEN_CHILD_ENVIRONMENT,
  WINDOWS_PROCESS_SCRIPT,
  exactKeys,
});
