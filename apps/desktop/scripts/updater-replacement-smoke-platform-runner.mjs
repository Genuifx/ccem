import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  createUpdaterReplacementChildEnvironment,
  sha256File,
  systemBootMonotonicMs,
  updaterReplacementPathIsInside,
} from './updater-replacement-smoke-runner-core.mjs';
import {
  createWindowsEvidenceRootAclCommand,
  validateWindowsEvidenceRootAclObservation,
} from './windows-mode2-production-smoke-inspection.mjs';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function fail(message) {
  throw new Error(`[updater-replacement-platform-runner] ${message}`);
}

async function command(program, args, options = {}) {
  try {
    return await execFileAsync(program, args, {
      cwd: options.cwd,
      env: options.environment,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    fail(`${program} failed: ${error.stderr?.trim() || error.message}`);
  }
}

function parseMacSignatureOutput(output, label) {
  const team = output.match(/(?:^|\n)TeamIdentifier=([A-Z0-9]{10})(?:\n|$)/u)?.[1];
  const identifier = output.match(/(?:^|\n)Identifier=([^\n]+)(?:\n|$)/u)?.[1];
  if (!team || !identifier) fail(`${label} lacks TeamIdentifier or Identifier`);
  return { teamIdentifier: team, identifier };
}

export async function inspectMacosCodeSignature({ bundlePath, executablePath }) {
  await command('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=4', bundlePath,
  ]);
  const display = await command('/usr/bin/codesign', [
    '--display', '--verbose=4', bundlePath,
  ]);
  const requirement = await command('/usr/bin/codesign', [
    '--display', '--requirements', '-', bundlePath,
  ]);
  const identity = parseMacSignatureOutput(
    `${display.stdout}\n${display.stderr}`,
    'macOS code signature',
  );
  const requirementText = `${requirement.stdout}\n${requirement.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('designated =>'))
    ?.slice('designated =>'.length)
    .trim();
  if (!requirementText) fail('macOS code signature lacks a designated requirement');
  return {
    valid: true,
    teamIdentifier: identity.teamIdentifier,
    bundleIdentifier: identity.identifier,
    designatedRequirementSha256: createHash('sha256').update(requirementText).digest('hex'),
    executableSha256: await sha256File(executablePath),
  };
}

export async function copyAndResignMacosFixture({
  sourceBundle,
  destinationBundle,
  poisonPath,
  poisonBytes,
  signingIdentity,
  environment = process.env,
}) {
  await command('/usr/bin/ditto', [sourceBundle, destinationBundle], { environment });
  await fsp.mkdir(path.dirname(poisonPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(poisonPath, poisonBytes, { flag: 'wx', mode: 0o600 });
  await command('/usr/bin/codesign', [
    '--force', '--options', 'runtime', '--timestamp', '--sign', signingIdentity,
    destinationBundle,
  ], { environment });
}

const AUTHENTICODE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = [System.IO.Path]::GetFullPath($env:CCEM_AUTHENTICODE_PATH)
$sig = Get-AuthenticodeSignature -LiteralPath $path
[ordered]@{
  Path = $path
  Status = $sig.Status.ToString()
  SignerThumbprint = if ($null -eq $sig.SignerCertificate) { $null } else { $sig.SignerCertificate.Thumbprint }
  SignerSubject = if ($null -eq $sig.SignerCertificate) { $null } else { $sig.SignerCertificate.Subject }
  TimestampThumbprint = if ($null -eq $sig.TimeStamperCertificate) { $null } else { $sig.TimeStamperCertificate.Thumbprint }
} | ConvertTo-Json -Compress
`;

export async function inspectWindowsAuthenticode(candidate, environment = process.env) {
  const childEnvironment = createUpdaterReplacementChildEnvironment(
    environment,
    { CCEM_AUTHENTICODE_PATH: path.win32.resolve(candidate) },
    'win32',
  );
  const result = await command('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', AUTHENTICODE_SCRIPT,
  ], { environment: childEnvironment });
  let signature;
  try {
    signature = JSON.parse(result.stdout);
  } catch (error) {
    fail(`parse Authenticode observation: ${error.message}`);
  }
  const timestampThumbprint = (signature.TimestampThumbprint ?? '').replaceAll(/\s/gu, '').toUpperCase();
  const signerThumbprint = (signature.SignerThumbprint ?? '').replaceAll(/\s/gu, '').toUpperCase();
  if (
    signature.Status !== 'Valid'
    || !/^[A-F0-9]{40}$/u.test(signerThumbprint)
    || !/^[A-F0-9]{40}$/u.test(timestampThumbprint)
  ) {
    fail(`invalid Authenticode signature: ${candidate}`);
  }
  return {
    status: 'Valid',
    signerThumbprint,
    publisher: signature.SignerSubject,
    timestampThumbprint,
    executableSha256: await sha256File(candidate),
  };
}

export const WINDOWS_TREE_SAFETY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($env:CCEM_WINDOWS_TREE_ROOT).TrimEnd('\')
$rootItem = Get-Item -LiteralPath $root -Force
$rootPrefix = $root + '\'
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($root)
$reparse = [Collections.Generic.List[string]]::new()
$ads = [Collections.Generic.List[string]]::new()
$reserved = [Collections.Generic.List[string]]::new()
$unsupported = [Collections.Generic.List[string]]::new()
while ($pending.Count -gt 0) {
  $directory = $pending.Pop()
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
    $attributes = [IO.File]::GetAttributes($entry)
    if (-not $entry.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "enumerated entry escaped the Windows tree root: $entry"
    }
    $relative = $entry.Substring($rootPrefix.Length).Replace('\', '/')
    $segments = $relative.Split('/')
    if ($segments | Where-Object { $_ -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$' }) {
      $reserved.Add($relative)
    }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $reparse.Add($relative)
      continue
    }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
      $pending.Push($entry)
      continue
    }
    $item = Get-Item -LiteralPath $entry -Force
    if ($item.PSIsContainer) {
      $unsupported.Add($relative)
      continue
    }
    foreach ($stream in @(Get-Item -LiteralPath $entry -Stream * -ErrorAction Stop)) {
      if ($stream.Stream -ne ':$DATA') { $ads.Add(($relative + ':' + $stream.Stream)) }
    }
  }
}
[ordered]@{
  rootType = if ($rootItem.PSIsContainer) { 'directory' } else { 'other' }
  rootNoReparsePoint = (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
  reparsePointPaths = @($reparse | Sort-Object -Unique)
  adsPaths = @($ads | Sort-Object -Unique)
  reservedNamePaths = @($reserved | Sort-Object -Unique)
  unsupportedEntries = @($unsupported | Sort-Object -Unique)
} | ConvertTo-Json -Depth 4 -Compress
`;

export async function inspectWindowsTreeSafety(root, environment = process.env) {
  const childEnvironment = createUpdaterReplacementChildEnvironment(
    environment,
    { CCEM_WINDOWS_TREE_ROOT: path.win32.resolve(root) },
    'win32',
  );
  const result = await command('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_TREE_SAFETY_SCRIPT,
  ], { environment: childEnvironment });
  let observation;
  try {
    observation = JSON.parse(result.stdout);
  } catch (error) {
    fail(`parse Windows no-follow tree safety observation: ${error.message}`);
  }
  for (const field of [
    'reparsePointPaths', 'adsPaths', 'reservedNamePaths', 'unsupportedEntries',
  ]) {
    if (!Array.isArray(observation[field])) fail(`Windows tree observation lacks ${field}`);
  }
  if (observation.rootType !== 'directory' || observation.rootNoReparsePoint !== true) {
    fail('Windows tree root is not a real non-reparse directory');
  }
  return observation;
}

export async function protectWindowsEvidenceRoot(root, environment = process.env) {
  const evidenceRoot = path.win32.resolve(root);
  const plan = { paths: { evidenceRoot } };
  const aclCommand = createWindowsEvidenceRootAclCommand({ plan });
  const childEnvironment = createUpdaterReplacementChildEnvironment(
    environment,
    {},
    'win32',
  );
  const result = await command(aclCommand.program, aclCommand.args, {
    environment: childEnvironment,
  });
  let observation;
  try {
    observation = JSON.parse(result.stdout);
  } catch (error) {
    fail(`parse Windows evidence-root ACL observation: ${error.message}`);
  }
  return validateWindowsEvidenceRootAclObservation(observation, plan);
}

const WINDOWS_PROCESS_CENSUS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$records = @(Get-CimInstance Win32_Process | ForEach-Object {
  [ordered]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    osStartToken = if ($null -eq $_.CreationDate) { $null } else { "windows:$($_.CreationDate.ToUniversalTime().ToString('o'))" }
    canonicalImagePath = if ($null -eq $_.ExecutablePath) { $null } else { [System.IO.Path]::GetFullPath($_.ExecutablePath) }
    commandLine = if ($null -eq $_.CommandLine) { '' } else { [string]$_.CommandLine }
  }
})
ConvertTo-Json -InputObject $records -Depth 3 -Compress
`;

async function macosProcessCensus(environment) {
  const childEnvironment = createUpdaterReplacementChildEnvironment(environment, {}, 'darwin');
  const result = await command('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    environment: childEnvironment,
  });
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      osStartToken: null,
      canonicalImagePath: match[3].trim().split(/\s+/u)[0],
      commandLine: match[3].trim(),
    }] : [];
  });
}

async function windowsProcessCensus(environment) {
  const childEnvironment = createUpdaterReplacementChildEnvironment(environment, {}, 'win32');
  const result = await command('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_CENSUS_SCRIPT,
  ], { environment: childEnvironment });
  try {
    const records = JSON.parse(result.stdout);
    return Array.isArray(records) ? records : [records];
  } catch (error) {
    fail(`parse Windows owned-process census: ${error.message}`);
  }
}

export function filterOwnedProcessCensus(records, {
  platform,
  roots,
  challengeNonce,
  harnessPid = process.pid,
  seedPids = [],
}) {
  if (
    !['macos', 'windows'].includes(platform)
    || !Array.isArray(roots)
    || roots.length === 0
    || !Array.isArray(seedPids)
  ) {
    fail('owned-process census requires a supported platform and roots');
  }
  const usableRecords = records.filter((record) => (
    Number.isSafeInteger(record?.pid)
    && record.pid > 0
    && Number.isSafeInteger(record?.parentPid)
    && record.parentPid >= 0
    && record.pid !== harnessPid
  ));
  const ownedPids = new Set(seedPids.filter((pid) => (
    Number.isSafeInteger(pid) && pid > 0 && pid !== harnessPid
  )));
  for (const record of usableRecords) {
    const commandLine = typeof record.commandLine === 'string' ? record.commandLine : '';
    const rootedImage = typeof record.canonicalImagePath === 'string'
      && roots.some((root) => updaterReplacementPathIsInside(
        record.canonicalImagePath,
        root,
        platform,
      ));
    if (
      rootedImage
      || roots.some((root) => commandLine.includes(root))
      || (typeof challengeNonce === 'string' && challengeNonce.length > 0
        && commandLine.includes(challengeNonce))
    ) {
      ownedPids.add(record.pid);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of usableRecords) {
      if (!ownedPids.has(record.pid) && ownedPids.has(record.parentPid)) {
        ownedPids.add(record.pid);
        changed = true;
      }
    }
  }
  return usableRecords
    .filter((record) => ownedPids.has(record.pid))
    .sort((left, right) => left.pid - right.pid);
}

export async function inspectOwnedProcessResidue({
  platform,
  roots,
  challengeNonce,
  seedPids = [],
  environment = process.env,
}) {
  const records = platform === 'macos'
    ? await macosProcessCensus(environment)
    : await windowsProcessCensus(environment);
  return filterOwnedProcessCensus(records, {
    platform,
    roots,
    challengeNonce,
    seedPids,
  });
}

export function assertNoOwnedProcessResidue(remaining) {
  if (!Array.isArray(remaining) || remaining.length > 0) {
    fail(`owned updater process residue remains: ${JSON.stringify(remaining)}`);
  }
}

export async function waitForOwnedProcessResidueZero({
  platform,
  roots,
  challengeNonce,
  seedPids = [],
  timeoutMs,
  environment = process.env,
}) {
  const deadline = Date.now() + timeoutMs;
  let remaining = [];
  do {
    remaining = await inspectOwnedProcessResidue({
      platform,
      roots,
      challengeNonce,
      seedPids,
      environment,
    });
    if (remaining.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assertNoOwnedProcessResidue(remaining);
  return remaining;
}

export async function installPreviousWindowsFixture({
  installerPath,
  installRoot,
  environment = process.env,
  timeoutMs = 120_000,
}) {
  const childEnvironment = createUpdaterReplacementChildEnvironment(
    environment,
    { CCEM_UPDATER_REPLACEMENT_SMOKE_ALLOW: '1' },
    'win32',
  );
  await new Promise((resolve, reject) => {
    const child = spawn(installerPath, ['/S', `/D=${installRoot}`], {
      env: childEnvironment,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('previous release fixture installer timed out'));
    }, timeoutMs);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`previous release fixture installer exited ${code}`));
    });
  });
}

export const WINDOWS_NSIS_OBSERVER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($env:CCEM_NSIS_TEMP_ROOT).TrimEnd('\') + '\'
$fileName = $env:CCEM_NSIS_FILE_NAME
$expectedParentPid = [int]$env:CCEM_NSIS_PARENT_PID
$expectedParentStartToken = $env:CCEM_NSIS_PARENT_START_TOKEN
$deadline = [DateTime]::UtcNow.AddSeconds([int]$env:CCEM_NSIS_TIMEOUT_SECONDS)
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $expectedParentPid"
if ($null -eq $parent -or $null -eq $parent.CreationDate -or $null -eq $parent.ExecutablePath) {
  throw 'previous app vanished before independent NSIS parent identity inspection'
}
$observedParentStartToken = "windows:$($parent.CreationDate.ToUniversalTime().ToString('o'))"
if ($observedParentStartToken -cne $expectedParentStartToken) {
  throw 'previous app start token differs from the independently observed parent process'
}
$parentPath = [System.IO.Path]::GetFullPath($parent.ExecutablePath)
$parentFile = Get-Item -LiteralPath $parentPath -Force
if ($parentFile.PSIsContainer -or ($parentFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'previous app image is not a regular non-reparse file'
}
$parentImageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $parentPath).Hash.ToLowerInvariant()
$sourceIdentifier = 'ccem-updater-replacement-nsis-' + [Guid]::NewGuid().ToString('N')
$null = Register-WmiEvent -Class Win32_ProcessStartTrace -SourceIdentifier $sourceIdentifier
try {
  [ordered]@{ kind = 'ready' } | ConvertTo-Json -Compress | Write-Output
  $observed = $null
  while ([DateTime]::UtcNow -lt $deadline -and $null -eq $observed) {
    $event = Wait-Event -SourceIdentifier $sourceIdentifier -Timeout 1
    if ($null -eq $event) { continue }
    $started = $event.SourceEventArgs.NewEvent
    Remove-Event -EventIdentifier $event.EventIdentifier
    if ($started.ProcessName -cne $fileName) { continue }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$started.ProcessID)"
    if ($null -eq $candidate -or $null -eq $candidate.ExecutablePath) { throw 'started NSIS process vanished before identity inspection' }
    $candidatePath = [System.IO.Path]::GetFullPath($candidate.ExecutablePath)
    if (-not $candidatePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { continue }
    if ([int]$started.ParentProcessID -ne $expectedParentPid) { throw 'NSIS process parent is not the independently observed previous app' }
    $observed = $candidate
    $observedParentPid = [int]$started.ParentProcessID
  }
  if ($null -eq $observed) { throw 'timed out waiting for updater NSIS process start event' }
} finally {
  Unregister-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue
  Get-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
}
$path = [System.IO.Path]::GetFullPath($observed.ExecutablePath)
$file = Get-Item -LiteralPath $path -Force
if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'NSIS executable is a reparse point' }
$signature = Get-AuthenticodeSignature -LiteralPath $path
$process = [Diagnostics.Process]::GetProcessById([int]$observed.ProcessId)
[ordered]@{
  kind = 'start'
  pid = [int]$observed.ProcessId
  parentPid = $observedParentPid
  parentOsStartToken = $observedParentStartToken
  parentCanonicalImagePath = $parentPath
  parentImageSha256 = $parentImageSha256
  osStartToken = "windows:$($observed.CreationDate.ToUniversalTime().ToString('o'))"
  canonicalImagePath = $path
  imageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  regularFile = -not $file.PSIsContainer
  noReparsePoint = (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
  authenticode = [ordered]@{
    status = $signature.Status.ToString()
    signerThumbprint = $signature.SignerCertificate.Thumbprint
    publisher = $signature.SignerCertificate.Subject
    timestampThumbprint = $signature.TimeStamperCertificate.Thumbprint
  }
} | ConvertTo-Json -Depth 4 -Compress | Write-Output
$process.WaitForExit()
[ordered]@{
  kind = 'exit'
  pid = [int]$observed.ProcessId
  code = [int]$process.ExitCode
} | ConvertTo-Json -Compress | Write-Output
`;

function jsonLineCollector(stream, onValue, onError) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onValue(JSON.parse(line));
      } catch (error) {
        onError(new Error(`invalid Windows NSIS observer JSON: ${error.message}`));
      }
    }
  });
}

export function startWindowsNsisObserver({
  updaterTempRoot,
  nsisFileName,
  expectedParentPid,
  expectedParentOsStartToken,
  environment = process.env,
  timeoutMs = 120_000,
}) {
  const childEnvironment = createUpdaterReplacementChildEnvironment(
    environment,
    {
      CCEM_NSIS_TEMP_ROOT: path.win32.resolve(updaterTempRoot),
      CCEM_NSIS_FILE_NAME: nsisFileName,
      CCEM_NSIS_PARENT_PID: String(expectedParentPid),
      CCEM_NSIS_PARENT_START_TOKEN: expectedParentOsStartToken,
      CCEM_NSIS_TIMEOUT_SECONDS: String(Math.ceil(timeoutMs / 1_000)),
    },
    'win32',
  );
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_NSIS_OBSERVER_SCRIPT,
  ], {
    env: childEnvironment,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let start;
  let readyResolve;
  let readyReject;
  let observationResolve;
  let observationReject;
  let exitResolve;
  let exitReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const observation = new Promise((resolve, reject) => {
    observationResolve = resolve;
    observationReject = reject;
  });
  const exited = new Promise((resolve, reject) => {
    exitResolve = resolve;
    exitReject = reject;
  });
  const reject = (error) => {
    readyReject(error);
    observationReject(error);
    exitReject(error);
  };
  jsonLineCollector(child.stdout, (value) => {
    if (value.kind === 'ready') readyResolve();
    else if (value.kind === 'start') start = value;
    else if (value.kind === 'exit' && start && value.pid === start.pid) {
      observationResolve({ start, exit: { ...value, bootMonotonicMs: systemBootMonotonicMs() } });
    } else reject(new Error('Windows NSIS observer emitted an invalid event sequence'));
  }, reject);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code !== 0) reject(new Error(`Windows NSIS observer exited ${code}: ${stderr.trim()}`));
    else exitResolve();
  });
  return { child, ready, observation, exited };
}

export const updaterReplacementPlatformRunnerInternals = Object.freeze({
  AUTHENTICODE_SCRIPT,
  WINDOWS_TREE_SAFETY_SCRIPT,
  parseMacSignatureOutput,
});
