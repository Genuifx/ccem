import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const desktop = path.resolve(import.meta.dirname, '..');
const artifacts = path.join(desktop, '.artifacts');
await fs.mkdir(artifacts, { recursive: true });
const directory = await fs.mkdtemp(path.join(artifacts, 'analytics-cache-'));
const outfile = path.join(directory, 'cache.mjs');
await build({
  entryPoints: [path.join(desktop, 'src/lib/analyticsModelBreakdown.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile,
  plugins: [{ name: 'ipc', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
      contents: 'export const invoke = (...args) => globalThis.__breakdownInvoke(...args);', loader: 'js',
    }));
  } }],
});
test.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });

let moduleId = 0;
async function setup() {
  const requests = [];
  globalThis.__breakdownInvoke = (command, args) => new Promise((resolve, reject) => {
    requests.push({ command, args, resolve, reject });
  });
  const { fetchModelBreakdown } = await import(`${pathToFileURL(outfile).href}?test=${moduleId++}`);
  return { requests, fetch: fetchModelBreakdown };
}
const oldData = { day: { old: { inputTokens: 100 } } };
const newData = { day: { current: { inputTokens: 200 } } };

test('deduplicates pending requests and reuses successful data for the same revision', async () => {
  const { requests, fetch } = await setup();
  const first = fetch('all', 'day', 'v1');
  const duplicate = fetch('all', 'day', 'v1');
  assert.equal(first, duplicate);
  assert.deepEqual(requests[0].args, { source: null, granularity: 'day' });
  requests[0].resolve(newData);
  assert.equal(await first, newData);
  assert.equal(await fetch('all', 'day', 'v1'), newData);
  assert.equal(requests.length, 1);
});

test('keeps source and granularity requests independent while a request is slow', async () => {
  const { requests, fetch } = await setup();
  const pending = [fetch('all', 'day', 'v1'), fetch('all', 'hour', 'v1'), fetch('codex', 'day', 'v1')];
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].args, { source: 'codex', granularity: 'day' });
  requests.forEach((request) => request.resolve(newData));
  await Promise.all(pending);
});

test('a failed request can be retried even when the statistics revision is unchanged', async () => {
  const { requests, fetch } = await setup();
  const failed = fetch('all', 'day', 'v1');
  requests[0].reject(new Error('unavailable'));
  await assert.rejects(failed, /unavailable/);
  const retry = fetch('all', 'day', 'v1');
  assert.equal(requests.length, 2);
  requests[1].resolve(newData);
  assert.equal(await retry, newData);
});

for (const outcome of ['resolve', 'reject']) {
  test(`an obsolete request cannot ${outcome === 'resolve' ? 'overwrite' : 'evict'} a newer cache entry`, async () => {
    const { requests, fetch } = await setup();
    const obsolete = fetch('all', 'day', 'v1').catch(() => null);
    const current = fetch('all', 'day', 'v2');
    requests[1].resolve(newData);
    await current;
    requests[0][outcome](outcome === 'resolve' ? oldData : new Error('obsolete failure'));
    await obsolete;
    assert.equal(await fetch('all', 'day', 'v2'), newData);
    assert.equal(requests.length, 2);
  });
}

test('a missing IPC reply times out, frees its key, and cannot overwrite a successful retry', async (t) => {
  const { requests, fetch } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = fetch('all', 'day', 'v1');
  const rejection = assert.rejects(hung, /timed out/);
  t.mock.timers.tick(60_000);
  await rejection;
  const retry = fetch('all', 'day', 'v1');
  requests[1].resolve(newData);
  await retry;
  requests[0].resolve(oldData);
  await Promise.resolve();
  assert.equal(await fetch('all', 'day', 'v1'), newData);
  assert.equal(requests.length, 2);
});

test('a successful cache entry expires and a new refresh revision bypasses fresh data', async (t) => {
  const { requests, fetch } = await setup();
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const first = fetch('all', 'day', 'v1');
  requests[0].resolve(oldData);
  await first;
  t.mock.timers.tick(60_000);
  const expired = fetch('all', 'day', 'v1');
  assert.equal(requests.length, 2);
  requests[1].resolve(newData);
  await expired;
  const refreshed = fetch('all', 'day', 'v2');
  assert.equal(requests.length, 3);
  requests[2].resolve(newData);
  await refreshed;
});
