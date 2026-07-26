import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  assertNoOwnedProcessResidue,
  filterOwnedProcessCensus,
  inspectWindowsTreeSafety,
  protectWindowsEvidenceRoot,
  WINDOWS_NSIS_OBSERVER_SCRIPT,
  updaterReplacementPlatformRunnerInternals,
} from '../scripts/updater-replacement-smoke-platform-runner.mjs';
import {
  createWindowsEvidenceRootAclCommand,
} from '../scripts/windows-mode2-production-smoke-inspection.mjs';

test('macOS signature parser requires exact Team ID and bundle identifier', () => {
  assert.deepEqual(
    updaterReplacementPlatformRunnerInternals.parseMacSignatureOutput(
      'Executable=/tmp/app\nIdentifier=com.ccem.desktop\nTeamIdentifier=ABCDE12345\n',
      'fixture',
    ),
    { teamIdentifier: 'ABCDE12345', identifier: 'com.ccem.desktop' },
  );
  assert.throws(
    () => updaterReplacementPlatformRunnerInternals.parseMacSignatureOutput(
      'Identifier=com.ccem.desktop\nTeamIdentifier=missing\n',
      'fixture',
    ),
    /lacks TeamIdentifier/u,
  );
});

test('Windows NSIS observer independently reads and binds parent identity plus dynamic plugin identity', () => {
  for (const required of [
    'CCEM_NSIS_TEMP_ROOT',
    'CCEM_NSIS_FILE_NAME',
    'CCEM_NSIS_PARENT_PID',
    'CCEM_NSIS_PARENT_START_TOKEN',
    'Register-WmiEvent',
    'Win32_ProcessStartTrace',
    'ParentProcessID',
    'CreationDate',
    'parentCanonicalImagePath',
    'parentImageSha256',
    'Get-FileHash',
    'Get-AuthenticodeSignature',
    'ReparsePoint',
    'WaitForExit',
    'ExitCode',
  ]) {
    assert.match(WINDOWS_NSIS_OBSERVER_SCRIPT, new RegExp(required, 'u'));
  }
  assert.doesNotMatch(
    WINDOWS_NSIS_OBSERVER_SCRIPT,
    /Start-Process|Invoke-Item|Get-CimInstance Win32_Process \| Where-Object/iu,
  );
  assert.match(
    WINDOWS_NSIS_OBSERVER_SCRIPT,
    /Get-CimInstance Win32_Process -Filter "ProcessId = \$expectedParentPid"/u,
  );
  assert.match(
    WINDOWS_NSIS_OBSERVER_SCRIPT,
    /parentOsStartToken = \$observedParentStartToken/u,
  );
  assert.doesNotMatch(
    WINDOWS_NSIS_OBSERVER_SCRIPT,
    /parentOsStartToken = \$expectedParentStartToken/u,
  );
});

test('Windows final tree scanner does not follow reparse points and enumerates ADS/reserved names', () => {
  const source = updaterReplacementPlatformRunnerInternals.WINDOWS_TREE_SAFETY_SCRIPT;
  for (const required of [
    'EnumerateFileSystemEntries', 'ReparsePoint', 'GetRelativePath',
    'Get-Item -LiteralPath $entry -Stream *', 'reservedNamePaths', 'unsupportedEntries',
  ]) {
    if (required === 'GetRelativePath') assert.ok(!source.includes(required));
    else assert.ok(source.includes(required), `missing Windows tree check: ${required}`);
  }
  assert.match(source, /Substring\(\$rootPrefix\.Length\)/u);
  const reparseBranch = source.indexOf('ReparsePoint) -ne 0');
  const directoryPush = source.indexOf('$pending.Push($entry)');
  assert.ok(reparseBranch > 0 && directoryPush > reparseBranch);
});

test('Windows PowerShell 5 tree scanner reports a real nested ADS with root-relative semantics', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-ps5-tree-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, 'nested');
  const file = path.join(nested, 'runtime.bin');
  await fsp.mkdir(nested);
  await fsp.writeFile(file, 'runtime');
  await fsp.writeFile(`${file}:ccem-test`, 'ads');
  const observation = await inspectWindowsTreeSafety(root);
  assert.equal(observation.rootType, 'directory');
  assert.equal(observation.rootNoReparsePoint, true);
  assert.deepEqual(observation.reparsePointPaths, []);
  assert.deepEqual(observation.adsPaths, ['nested/runtime.bin:ccem-test']);
  assert.deepEqual(observation.reservedNamePaths, []);
  assert.deepEqual(observation.unsupportedEntries, []);
});

test('Windows updater evidence root is protected for only the runner owner and SYSTEM', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-evidence-acl-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const observation = await protectWindowsEvidenceRoot(root);
  assert.equal(path.win32.normalize(observation.rootPath), path.win32.normalize(root));
  assert.equal(observation.systemSid, 'S-1-5-18');
  assert.equal(observation.inheritanceProtected, true);
  assert.deepEqual(observation.allowedSids, ['S-1-5-18', observation.ownerSid].sort());
  assert.equal(observation.aceCount, 2);
  assert.equal(observation.fullControlOnly, true);
  assert.equal(observation.reparseFree, true);
});

test('Windows updater ACL command rejects reparse ancestors and emits an exact protected DACL', () => {
  const command = createWindowsEvidenceRootAclCommand({
    plan: { paths: { evidenceRoot: 'D:\\a\\_temp\\fixture\\evidence' } },
  });
  const source = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  for (const required of [
    'Assert-NoReparseAncestors $root',
    'evidence root ancestor contains a reparse point',
    'SetAccessRuleProtection($true, $false)',
    'S-1-5-18',
    'FileSystemRights]::FullControl',
    '$actualRules.Count -ne 2',
  ]) assert.ok(source.includes(required), `missing Windows updater ACL check: ${required}`);
});

test('owned-process census exposes a surviving descendant or challenge-bound helper', () => {
  const nonce = 'ab'.repeat(32);
  const residue = filterOwnedProcessCensus([
    {
      pid: 41,
      parentPid: 40,
      osStartToken: 'windows:2026-01-01T00:00:00.0000000Z',
      canonicalImagePath: 'D:\\fixture\\app\\CCEM Helper.exe',
      commandLine: '"D:\\fixture\\app\\CCEM Helper.exe" --type=renderer',
    },
    {
      pid: 42,
      parentPid: 1,
      osStartToken: 'windows:2026-01-01T00:00:01.0000000Z',
      canonicalImagePath: 'C:\\Windows\\System32\\cmd.exe',
      commandLine: `cmd.exe --challenge ${nonce}`,
    },
  ], {
    platform: 'windows',
    roots: ['D:\\fixture\\app'],
    challengeNonce: nonce,
    harnessPid: 99,
  });
  assert.deepEqual(residue.map(({ pid }) => pid), [41, 42]);
  assert.throws(() => assertNoOwnedProcessResidue(residue), /process residue remains/u);
});

test('owned-process census closes transitively over descendants of exited owned PIDs', () => {
  const nonce = 'cd'.repeat(32);
  const residue = filterOwnedProcessCensus([
    {
      pid: 501,
      parentPid: 500,
      osStartToken: 'windows:2026-01-01T00:00:01.0000000Z',
      canonicalImagePath: 'C:\\Windows\\System32\\conhost.exe',
      commandLine: 'conhost.exe 0x4',
    },
    {
      pid: 502,
      parentPid: 501,
      osStartToken: 'windows:2026-01-01T00:00:02.0000000Z',
      canonicalImagePath: 'C:\\Windows\\System32\\cmd.exe',
      commandLine: 'cmd.exe /d /s /c pause',
    },
    {
      pid: 503,
      parentPid: 1,
      osStartToken: 'windows:2026-01-01T00:00:03.0000000Z',
      canonicalImagePath: 'C:\\Windows\\System32\\notepad.exe',
      commandLine: 'notepad.exe',
    },
  ], {
    platform: 'windows',
    roots: ['D:\\fixture\\app'],
    challengeNonce: nonce,
    harnessPid: 99,
    seedPids: [500],
  });
  assert.deepEqual(residue.map(({ pid }) => pid), [501, 502]);
  assert.throws(() => assertNoOwnedProcessResidue(residue), /process residue remains/u);
});
