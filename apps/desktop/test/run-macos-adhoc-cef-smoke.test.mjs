import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPhase, validateReceipt } from '../scripts/run-macos-adhoc-cef-smoke.mjs';

test('missing or empty bundle path fails, while explicit help succeeds', () => {
  const runner = fileURLToPath(new URL('../scripts/run-macos-adhoc-cef-smoke.mjs', import.meta.url));
  for (const args of [[], ['']]) {
    const result = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^Usage:/);
    assert.doesNotMatch(result.stdout, /PASS|Receipt:/);
  }
  for (const flag of ['--help', '-h']) {
    const result = spawnSync(process.execPath, [runner, flag], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage:/);
    assert.equal(result.stderr, '');
  }
});

const expected = { nonce: 'a'.repeat(32), phase: 'restore', root: '/private/tmp/owned-smoke', executable: '/test.app/Contents/MacOS/test', pid: 123, origin: 'http://127.0.0.1:1234/' };
function receipt() {
  return {
    schemaVersion: 1, smoke: 'macos-adhoc-cef-bundle', status: 'passed', ...expected,
    eventCode: 0, error: null, normalStartupBypassed: true, releaseBuild: true,
    facts: {
      bundled: true, sandboxEnabled: true, persistentProfile: true, visible: true, hideShowVerified: true, closed: true,
      credentialStore: 'macos-system-keychain-adhoc',
      before: { title: 'CCEM_BUNDLE_START', url: `${expected.origin}start`, cookie: `ccem_bundle_smoke=${expected.nonce}` },
      after: { title: 'CCEM_BUNDLE_NAVIGATED', url: `${expected.origin}navigated`, cookie: `ccem_bundle_smoke=${expected.nonce}` },
    },
  };
}

test('requires this process, phase, profile root, runtime facts and actual renderer results', () => {
  assert.doesNotThrow(() => validateReceipt(receipt(), expected));
  for (const [key, bad] of [['pid', 124], ['phase', 'prime'], ['root', '/user/.ccem'], ['nonce', 'b'.repeat(32)], ['executable', '/Applications/Other.app'], ['releaseBuild', false], ['normalStartupBypassed', false], ['eventCode', 1]]) {
    const value = receipt(); value[key] = bad;
    assert.throws(() => validateReceipt(value, expected), `must reject ${key}`);
  }
  for (const key of ['bundled', 'sandboxEnabled', 'persistentProfile', 'visible', 'hideShowVerified', 'closed']) {
    const value = receipt(); value.facts[key] = false;
    assert.throws(() => validateReceipt(value, expected), `must reject ${key}`);
  }
  for (const mutate of [value => { value.facts.credentialStore = 'chromium-mock-keychain'; }, value => { value.facts.before.cookie = ''; }, value => { value.facts.after.title = 'about:blank'; }, value => { value.facts.after.url = `${expected.origin}start`; }]) {
    const value = receipt(); mutate(value);
    assert.throws(() => validateReceipt(value, expected));
  }
});

test('a successful exit without a receipt cannot pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccem-smoke-test-'));
  const executable = join(root, 'empty');
  try {
    await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o700);
    await assert.rejects(runPhase({ ...expected, root, executable, timeoutMs: 1_000 }), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('timeout terminates only its spawned process and does not accept stale evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccem-smoke-test-'));
  const executable = join(root, 'hanging');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`); await chmod(executable, 0o700);
    await writeFile(join(root, 'restore.json'), JSON.stringify(receipt()));
    await assert.rejects(runPhase({ ...expected, root, executable, timeoutMs: 100 }), /timed out; only spawned PID/);
    assert.equal(unrelated.exitCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally { unrelated.kill('SIGTERM'); await rm(root, { recursive: true, force: true }); }
});
