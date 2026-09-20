import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

async function loadModule(t) {
  const source = await fs.readFile(new URL(
    '../src/components/workspace/workspaceTranscriptBackfill.ts', import.meta.url,
  ), 'utf8');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-read-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'backfill.mjs');
  await fs.writeFile(file, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText);
  return import(pathToFileURL(file).href);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const request = (load, key = 'runtime:page', scope = 'runtime') => ({
  load, physicalRequestKey: key, physicalRequestScope: scope,
  isComplete: () => true, retryDelaysMs: [], timeoutMs: 5,
});

test('an unexpired equivalent read is coalesced, including after waiter cancellation', async (t) => {
  const { runTranscriptBackfillWithRetry: run } = await loadModule(t);
  const pending = deferred();
  let calls = 0;
  const options = { ...request(() => { calls++; return pending.promise; }), timeoutMs: 1_000 };
  const controller = new AbortController();
  const first = run({ ...options, signal: controller.signal });
  await tick();
  controller.abort();
  assert.equal((await first).status, 'cancelled');
  const second = run(options);
  const third = run(options);
  await tick();
  assert.equal(calls, 1);
  pending.resolve('same result');
  assert.equal((await second).value, 'same result');
  assert.equal((await third).value, 'same result');
});

test('one never-settling read does not pin the cursor or later pages', async (t) => {
  const { runTranscriptBackfillWithRetry: run } = await loadModule(t);
  let calls = 0;
  const load = async () => {
    calls++;
    return calls === 1 ? new Promise(() => {}) : calls;
  };
  assert.equal((await run(request(load))).status, 'error');
  for (let cursor = 0; cursor < 5; cursor++) {
    assert.equal((await run(request(load, `runtime:page:${cursor}`))).status, 'success');
  }
  assert.equal(calls, 6);
});

test('two unresolved reads remain counted across repeated retries, cursors and initial/full paths', async (t) => {
  const { runTranscriptBackfillWithRetry: run, runTranscriptPagedBackfill: pages } = await loadModule(t);
  let calls = 0;
  const load = () => { calls++; return new Promise(() => {}); };
  assert.equal((await run(request(load))).status, 'error');
  assert.equal((await run(request(load))).status, 'error');
  for (let i = 0; i < 3; i++) {
    const blocked = await run(request(load));
    assert.equal(blocked.status, 'error');
    assert.equal(blocked.error.name, 'TranscriptBackfillBusyError');
  }
  assert.equal((await run(request(load, 'runtime:initial'))).status, 'error');
  assert.equal((await pages({
    loadPage: load, initialAfterSeq: 42, physicalRequestKey: 'runtime:incremental',
    physicalRequestScope: 'runtime', isComplete: () => true, timeoutMs: 5,
  })).status, 'error');
  assert.equal((await pages({
    loadPage: load, physicalRequestKey: 'runtime', isComplete: () => true, timeoutMs: 5,
  })).status, 'error');
  assert.equal(calls, 2, 'changing page or mode must not bypass the physical runtime budget');
  assert.equal((await run(request(async () => 'other', 'other:page', 'other'))).value, 'other');
});

for (const settlement of ['resolve', 'reject']) {
  test(`late ${settlement} only releases the retired read, not its replacement`, async (t) => {
    const { runTranscriptBackfillWithRetry: run } = await loadModule(t);
    const retired = deferred();
    const fresh = deferred();
    let calls = 0;
    const load = () => ++calls === 1 ? retired.promise : fresh.promise;
    assert.equal((await run(request(load))).status, 'error');
    const replacement = run({ ...request(load), timeoutMs: 1_000 });
    await tick();
    retired[settlement](settlement === 'resolve' ? 'old' : new Error('old failure'));
    await tick();
    const concurrent = run({ ...request(load), timeoutMs: 1_000 });
    await tick();
    assert.equal(calls, 2);
    fresh.resolve('new');
    assert.equal((await replacement).value, 'new');
    assert.equal((await concurrent).value, 'new');
    assert.equal((await run(request(async () => 'next'))).value, 'next');
  });
}

test('a late physical settlement restores capacity after both reads time out', async (t) => {
  const { runTranscriptBackfillWithRetry: run } = await loadModule(t);
  const old = deferred();
  let calls = 0;
  const load = () => {
    calls++;
    if (calls === 1) return old.promise;
    if (calls === 2) return new Promise(() => {});
    return Promise.resolve('recovered');
  };
  assert.equal((await run(request(load))).status, 'error');
  assert.equal((await run(request(load))).status, 'error');
  assert.equal((await run(request(load))).status, 'error');
  assert.equal(calls, 2);
  old.resolve('retired');
  await tick();
  assert.equal((await run(request(load))).value, 'recovered');
  assert.equal(calls, 3);
});

test('an aborted waiter does not prevent expiry or erase the physical limit', async (t) => {
  const { runTranscriptBackfillWithRetry: run } = await loadModule(t);
  const controller = new AbortController();
  let calls = 0;
  const load = () => { calls++; return new Promise(() => {}); };
  const first = run({ ...request(load), signal: controller.signal, timeoutMs: 20 });
  await tick();
  controller.abort();
  assert.equal((await first).status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await run(request(load))).status, 'error');
  assert.equal(calls, 2);
  assert.equal((await run(request(load, 'runtime:another-cursor'))).status, 'error');
  assert.equal(calls, 2);
});

test('wall-clock rollback cannot revive an expired read lease', async (t) => {
  const { runTranscriptBackfillWithRetry: run } = await loadModule(t);
  const originalNow = Date.now;
  t.after(() => { Date.now = originalNow; });
  let calls = 0;
  const load = () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve('recovered');
  assert.equal((await run(request(load))).status, 'error');
  Date.now = () => originalNow() - 60 * 60 * 1_000;
  assert.equal((await run(request(load))).value, 'recovered');
  assert.equal(calls, 2);
});

test('the timeout expires its read even if the lease clock has not reached the deadline', async (t) => {
  const { runTranscriptBackfillWithRetry: run } = await loadModule(t);
  t.mock.method(performance, 'now', () => 100);
  let calls = 0;
  const load = () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve('recovered');
  assert.equal((await run(request(load))).error.name, 'TranscriptBackfillTimeoutError');
  assert.equal((await run(request(load))).value, 'recovered');
  assert.equal(calls, 2);
});

test('an older coalesced waiter timing out cannot expire the replacement read', async (t) => {
  const { runTranscriptBackfillWithRetry: run } = await loadModule(t);
  t.mock.method(performance, 'now', () => 100);
  const fresh = deferred();
  let calls = 0;
  const load = () => ++calls === 1 ? new Promise(() => {}) : fresh.promise;
  const first = run(request(load));
  const oldWaiter = run({ ...request(load), timeoutMs: 40 });
  assert.equal((await first).error.name, 'TranscriptBackfillTimeoutError');
  const replacement = run({ ...request(load), timeoutMs: 1_000 });
  assert.equal((await oldWaiter).error.name, 'TranscriptBackfillTimeoutError');
  const concurrent = run({ ...request(load), timeoutMs: 1_000 });
  await tick();
  assert.equal(calls, 2);
  fresh.resolve('new');
  assert.equal((await replacement).value, 'new');
  assert.equal((await concurrent).value, 'new');
});
