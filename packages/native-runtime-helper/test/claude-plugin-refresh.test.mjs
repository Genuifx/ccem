import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-plugin-refresh-test-'));
after(() => fs.rm(temporary, { recursive: true, force: true }));
const outfile = path.join(temporary, 'claudePluginRefresh.mjs');
await build({
  entryPoints: [fileURLToPath(new URL('../src/claudePluginRefresh.ts', import.meta.url))],
  outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
});
const { ClaudePluginRefresh } = await import(pathToFileURL(outfile).href);

function fixture(options = {}) {
  let revision = 'initial-ledger';
  let idle = true;
  const calls = [];
  const warnings = [];
  const refresh = new ClaudePluginRefresh({
    prepare: () => { calls.push('import'); return revision; },
    warn: (message) => warnings.push(message),
    ...options,
  });
  const query = {
    async applyFlagSettings(settings) { assert.deepEqual(settings, {}); calls.push('settings'); },
    async reloadPlugins() { calls.push('reload'); },
    close() { assert.fail('Plugin refresh must not close the query'); },
  };
  refresh.trackQuery(query, refresh.prepareQuery());
  calls.length = 0;
  return {
    refresh, query, calls, warnings,
    change: (value = 'new-ledger') => { revision = value; },
    setIdle: (value) => { idle = value; },
    ready: () => idle,
  };
}

test('unchanged plugin ledger leaves a retained query untouched', async () => {
  const f = fixture();
  await f.refresh.beforePrompt(f.query, f.ready);
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'import']);
  assert.deepEqual(f.warnings, []);
});

test('idle import refreshes settings before plugins once without replacing the query', async () => {
  const f = fixture();
  f.change();
  await f.refresh.beforePrompt(f.query, f.ready);
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'settings', 'reload', 'import']);
});

test('busy or background work defers both disk import and runtime refresh', async () => {
  const f = fixture();
  f.change();
  f.setIdle(false);
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, []);
  f.setIdle(true);
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'settings', 'reload']);
});

test('failed refresh warns and retries the same ledger on the next prompt', async () => {
  const f = fixture();
  f.change();
  let attempts = 0;
  f.query.reloadPlugins = async () => {
    f.calls.push('reload');
    if (++attempts === 1) throw new Error('fixture reload failure');
  };
  await assert.doesNotReject(f.refresh.beforePrompt(f.query, f.ready));
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /fixture reload failure/);
  await f.refresh.beforePrompt(f.query, f.ready);
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'settings', 'reload', 'import', 'settings', 'reload', 'import']);
});

test('settings refresh failure does not run reload or consume the revision', async () => {
  const f = fixture();
  f.change();
  const apply = f.query.applyFlagSettings;
  f.query.applyFlagSettings = async () => { throw new Error('fixture settings failure'); };
  await assert.doesNotReject(f.refresh.beforePrompt(f.query, f.ready));
  assert.deepEqual(f.calls, ['import']);
  f.query.applyFlagSettings = apply;
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'import', 'settings', 'reload']);
});

test('concurrent prompt preparation shares one in-flight plugin refresh', async () => {
  const f = fixture();
  f.change();
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  f.query.applyFlagSettings = async () => { f.calls.push('settings'); await gate; };
  const first = f.refresh.beforePrompt(f.query, f.ready);
  const second = f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'settings']);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(f.calls, ['import', 'settings', 'reload']);
});

test('query replacement or newly started work during settings refresh defers reload', async () => {
  const f = fixture();
  f.change();
  f.query.applyFlagSettings = async () => { f.calls.push('settings'); f.setIdle(false); };
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'settings']);
  f.setIdle(true);
  f.query.applyFlagSettings = async () => { f.calls.push('settings'); };
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'settings', 'import', 'settings', 'reload']);
});

test('a ledger change during reload is picked up again on the next prompt', async () => {
  const f = fixture();
  f.change('first-import');
  f.query.reloadPlugins = async () => { f.calls.push('reload'); f.change('second-import'); };
  await f.refresh.beforePrompt(f.query, f.ready);
  await f.refresh.beforePrompt(f.query, f.ready);
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.equal(f.calls.filter((call) => call === 'reload').length, 2);
});

test('preparation failures preserve ordinary prompts and remain retryable', async () => {
  let fail = true;
  const warnings = [];
  const refresh = new ClaudePluginRefresh({
    prepare: () => { if (fail) throw new Error('fixture invalid registry'); return 'repaired'; },
    warn: (message) => warnings.push(message),
  });
  const calls = [];
  const query = {
    async applyFlagSettings() { calls.push('settings'); },
    async reloadPlugins() { calls.push('reload'); },
  };
  refresh.trackQuery(query, refresh.prepareQuery());
  await assert.doesNotReject(refresh.beforePrompt(query, () => true));
  assert.deepEqual(calls, []);
  fail = false;
  await refresh.beforePrompt(query, () => true);
  assert.deepEqual(calls, ['settings', 'reload']);
  assert.equal(warnings.length, 2);
});

test('a hung settings control has bounded waiting and its late reply cannot reload during a turn', async () => {
  const f = fixture({ timeoutMs: 10 });
  f.change();
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  f.query.applyFlagSettings = async () => { f.calls.push('settings'); await gate; };
  await f.refresh.beforePrompt(f.query, f.ready);
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'settings']);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /continuing the prompt/);
  f.setIdle(false);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.includes('reload'), false);
  f.setIdle(true);
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'settings', 'import', 'settings', 'reload']);
});

test('a timed-out reload remains single-flight and cannot acknowledge a retired or busy query', async () => {
  const f = fixture({ timeoutMs: 10 });
  f.change();
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  f.query.reloadPlugins = async () => { f.calls.push('reload'); await gate; };
  await f.refresh.beforePrompt(f.query, f.ready);
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.deepEqual(f.calls, ['import', 'settings', 'reload']);
  f.setIdle(false);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  f.setIdle(true);
  await f.refresh.beforePrompt(f.query, f.ready);
  assert.equal(f.calls.filter((call) => call === 'reload').length, 2);
});
