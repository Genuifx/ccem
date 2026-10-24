import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { withCodexFixtureCleanup } from './codex-fixture-lifecycle.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t, { omitReady = false, wrongOwner = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem lifecycle '));
  const capture = path.join(root, 'capture.json');
  const gate = path.join(root, 'release');
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const fixture = spawn(process.execPath, ['-e', \`
      const fs = require('node:fs');
      fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({pid:process.pid, ppid:${wrongOwner ? '0' : 'process.ppid'}}));
      const timer = setInterval(() => { if (fs.existsSync(process.env.FIXTURE_GATE)) { clearInterval(timer); } }, 10);
    \`], { cwd: ${JSON.stringify(root)}, stdio: 'ignore' });
    const emit = (detail) => process.stdout.write(JSON.stringify({type:'status',status:'ready',detail})+'\\n');
    emit('Native runtime helper initialized.');
    fixture.once('close', () => { ${omitReady ? '' : "emit('Ready for the next prompt.');"} });
    process.stdin.on('data', (chunk) => { if (chunk.toString().includes('"stop"')) fixture.kill(); });
  `], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FIXTURE_CAPTURE: capture, FIXTURE_GATE: gate } });
  const closed = new Promise((resolve) => child.once('close', resolve));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // Rescue only our own fixture, even when the lifecycle assertion intentionally fails.
  t.after(async () => {
    await fs.writeFile(gate, 'release');
    if (child.stdin.writable) child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n');
    if (captured) {
      let gone = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(captured.pid, 0); }
        catch (error) { if (error.code !== 'ESRCH') throw error; gone = true; break; }
        await sleep(10);
      }
      assert.ok(gone, `Rescue could not prove fixture ${captured.pid} exited; retained ${root}`);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await fs.rm(root, { recursive: true, force: true });
  });
  let captured;
  for (let n = 0; n < 200; n++) {
    try { captured = JSON.parse(await fs.readFile(capture, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await sleep(10);
  }
  assert.ok(captured, stderr);
  return { root, gate, captured, options: { child, closed, capture, output: () => ({ stdout, stderr }), timeoutMs: 1000, shutdownMs: 1000 } };
}

test('cleanup waits after capture and initial ready until the delayed fixture exits', async (t) => {
  const f = await fixture(t);
  let finished = false;
  const running = withCodexFixtureCleanup(f.options, async () => {}).finally(() => { finished = true; });
  await sleep(50);
  assert.equal(finished, false, 'capture or initial-ready is not SDK-exit evidence');
  assert.doesNotThrow(() => process.kill(f.captured.pid, 0));
  await fs.writeFile(f.gate, 'release');
  await running;
  assert.throws(() => process.kill(f.captured.pid, 0), { code: 'ESRCH' });
});

test('failed assertions still wait for fixture exit and preserve the original failure', async (t) => {
  const f = await fixture(t);
  const failure = new Error('intentional assertion failure');
  const running = withCodexFixtureCleanup(f.options, async () => { throw failure; });
  const rejected = assert.rejects(running, (error) => error === failure);
  await sleep(50);
  assert.doesNotThrow(() => process.kill(f.captured.pid, 0));
  await fs.writeFile(f.gate, 'release');
  await rejected;
  assert.throws(() => process.kill(f.captured.pid, 0), { code: 'ESRCH' });
});

test('missing post-turn ready times out, stops the owned fixture and preserves timeout evidence', async (t) => {
  const f = await fixture(t, { omitReady: true });
  await assert.rejects(withCodexFixtureCleanup({ ...f.options, timeoutMs: 30 }, async () => {}),
    (error) => /post-turn ready/.test(error.message) && error.fixtureCleanupIncomplete === false);
  assert.throws(() => process.kill(f.captured.pid, 0), { code: 'ESRCH' });
  assert.notEqual(f.options.child.exitCode ?? f.options.child.signalCode, null);
});

test('unproven fixture ownership preserves assertion and cleanup errors and requests retained evidence', async (t) => {
  const f = await fixture(t, { omitReady: true, wrongOwner: true });
  const failure = new Error('intentional assertion failure');
  await assert.rejects(withCodexFixtureCleanup({ ...f.options, timeoutMs: 30 }, async () => { throw failure; }),
    (error) => error instanceof AggregateError && error.errors.includes(failure)
      && error.fixtureCleanupIncomplete === true && /ownership/.test(error.errors[1].message));
});

test('a helper already closed before cleanup still requires fixture-exit proof', async (t) => {
  const f = await fixture(t, { omitReady: true });
  await fs.writeFile(f.gate, 'release');
  f.options.child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n');
  await f.options.closed;
  await assert.rejects(withCodexFixtureCleanup(f.options, async () => {}),
    (error) => /closed before exact post-turn ready/.test(error.message) && error.fixtureCleanupIncomplete === false);
});

test('a stop-pipe error is captured even when emitted after its callback', async (t) => {
  const f = await fixture(t, { omitReady: true });
  const pipeError = Object.assign(new Error('fixture stop pipe closed'), { code: 'EPIPE' });
  // Exercise Node's callback-then-error event ordering with real child lifetimes.
  const originalEnd = f.options.child.stdin.end;
  f.options.child.stdin.end = function (_command, callback) {
    this.end = originalEnd;
    void fs.writeFile(f.gate, 'release').then(() => {
      callback(pipeError);
      this.emit('error', pipeError);
    });
    return this;
  };
  await assert.rejects(withCodexFixtureCleanup({ ...f.options, timeoutMs: 30 }, async () => {}),
    (error) => /fixture stop pipe closed/.test(error.message) && error.fixtureCleanupIncomplete === true);
});

test('missing capture evidence fails cleanup without authorizing cwd removal', async (t) => {
  const f = await fixture(t, { omitReady: true });
  await fs.unlink(f.options.capture);
  await assert.rejects(withCodexFixtureCleanup({ ...f.options, timeoutMs: 30 }, async () => {}),
    (error) => error.fixtureCleanupIncomplete === true && error.errors.some((item) => item.code === 'ENOENT'));
});

test('a stop write that never acknowledges cannot bypass the cleanup deadline', async (t) => {
  const f = await fixture(t, { omitReady: true });
  const originalEnd = f.options.child.stdin.end;
  f.options.child.stdin.end = function () {
    this.end = originalEnd;
    void fs.writeFile(f.gate, 'release');
    return this; // Deliberately omit the write callback.
  };
  const running = withCodexFixtureCleanup({ ...f.options, timeoutMs: 30, shutdownMs: 100 }, async () => {});
  let deadline;
  try {
    await assert.rejects(Promise.race([running, new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('test deadline exceeded')), 2000);
    })]), (error) => /Timed out writing fixture stop command/.test(error.message) && error.fixtureCleanupIncomplete === true);
  } finally {
    clearTimeout(deadline);
  }
});
