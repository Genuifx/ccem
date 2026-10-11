import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-codex-turn-usage-'));
after(() => fs.rm(tempRoot, { recursive: true, force: true }));
const outfile = path.join(tempRoot, 'codexTurnUsage.mjs');
await build({
  entryPoints: [fileURLToPath(new URL('../src/codexTurnUsage.ts', import.meta.url))],
  outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
});
const { captureCodexUsageBaseline, resolveCodexTurnUsage } = await import(pathToFileURL(outfile).href);
const SESSION = '019dbb39-4e70-7351-a75d-3847d4288e31';
const OTHER = '019dbb39-4e70-7351-a75d-3847d4288e32';
const row = (type, payload) => ({ type, payload });
const event = (type, payload = {}) => row('event_msg', { type, ...payload });
const start = (turn = 'turn-1') => event('task_started', { turn_id: turn });
const complete = (turn = 'turn-1') => event('task_complete', { turn_id: turn });
const context = (turn = 'turn-1') => row('turn_context', { turn_id: turn });
const meta = (extra = {}) => row('session_meta', { id: SESSION, ...extra });
const raw = (input, output, cached = 0, reasoning = 0, cacheWrite = 0) => ({
  input_tokens: input, output_tokens: output, cached_input_tokens: cached,
  cache_write_input_tokens: cacheWrite, reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});
const tokenCount = (total, last = total) => event('token_count', { info: { total_token_usage: total, last_token_usage: last } });
const ledger = (request, turn = request, turnId = 'turn-1', responseId = 'response-1', extra = {}) => row('token_usage_record', {
  thread_id: SESSION, turn_id: turnId, response_id: responseId,
  usage: request, turn_token_usage: turn, ...extra,
});
const encode = (rows) => `${rows.map((item) => JSON.stringify(item)).join('\n')}\n`;

async function fixture(rows = []) {
  const home = await fs.mkdtemp(path.join(tempRoot, 'home-'));
  const dir = path.join(home, 'sessions', '2026', '10', '11');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-test-${SESSION}.jsonl`);
  if (rows.length) await fs.writeFile(file, encode(rows));
  return { home, file, append: (items) => fs.appendFile(file, encode(items)) };
}

test('new turn uses explicit records, counts every request, and excludes cache/reasoning duplication', async () => {
  const f = await fixture();
  const baseline = captureCodexUsageBaseline(null, f.home);
  const first = raw(100, 10, 40, 5, 20);
  const second = raw(200, 20, 120, 8, 30);
  const total = raw(300, 30, 160, 13, 50);
  await f.append([meta(), start(), context(), ledger(first), ledger(second, total, 'turn-1', 'response-2'), complete()]);
  assert.deepEqual(await resolveCodexTurnUsage(SESSION, baseline, f.home), {
    inputTokens: 90, outputTokens: 30, cacheReadTokens: 160, cacheCreationTokens: 50,
  });
});

test('resumed turns ignore inherited history, including repeated completions and ledger records', async () => {
  const f = await fixture([meta({ forked_from_id: OTHER }), start('previous'), ledger(raw(900, 200), raw(900, 200), 'previous'), tokenCount(raw(900, 200)), complete('previous')]);
  const baseline = captureCodexUsageBaseline(SESSION, f.home);
  const newRecord = ledger(raw(100, 12, 25), undefined, 'turn-1');
  await f.append([start(), context(), newRecord, newRecord, complete(), complete()]);
  assert.deepEqual(await resolveCodexTurnUsage(SESSION, baseline), {
    inputTokens: 75, outputTokens: 12, cacheReadTokens: 25, cacheCreationTokens: 0,
  });
  const nextBaseline = captureCodexUsageBaseline(SESSION, f.home);
  await f.append([start('turn-2'), ledger(raw(50, 3), undefined, 'turn-2'), complete('turn-2')]);
  assert.equal((await resolveCodexTurnUsage(SESSION, nextBaseline)).outputTokens, 3);
});

test('old CLI uses cumulative difference across requests and ignores repeated context snapshots', async () => {
  const f = await fixture([meta(), start('previous'), tokenCount(raw(1000, 100, 400, 20)), complete('previous')]);
  const baseline = captureCodexUsageBaseline(SESSION, f.home);
  await f.append([
    start(), context(), tokenCount(raw(1000, 100, 400, 20)),
    tokenCount(raw(1200, 120, 500, 25), raw(200, 20, 100, 5)),
    row('compacted', {}), context(),
    tokenCount(raw(1200, 120, 500, 25), raw(0, 0)),
    tokenCount(raw(1300, 130, 525, 28), raw(100, 10, 25, 3)), complete(),
  ]);
  assert.deepEqual(await resolveCodexTurnUsage(SESSION, baseline), {
    inputTokens: 175, outputTokens: 30, cacheReadTokens: 125, cacheCreationTokens: 0,
  });
});

test('new old-format thread has an explicit zero baseline', async () => {
  const f = await fixture();
  const baseline = captureCodexUsageBaseline(null, f.home);
  await f.append([meta(), start(), tokenCount(raw(100, 10, 80, 4)), complete()]);
  assert.deepEqual(await resolveCodexTurnUsage(SESSION, baseline), {
    inputTokens: 20, outputTokens: 10, cacheReadTokens: 80, cacheCreationTokens: 0,
  });
});

test('counter reset cannot masquerade as positive final growth; exact turn records survive it', async () => {
  const f = await fixture([meta(), start('old'), tokenCount(raw(100, 100)), complete('old')]);
  const baseline = captureCodexUsageBaseline(SESSION, f.home);
  const reset = { ...raw(0, 0), total_tokens: 200000 };
  await f.append([start(), tokenCount(reset), tokenCount(raw(500, 300)), complete()]);
  assert.equal(await resolveCodexTurnUsage(SESSION, baseline), null);
  const g = await fixture([meta(), start('old'), tokenCount(raw(100, 100)), complete('old')]);
  const exactBaseline = captureCodexUsageBaseline(SESSION, g.home);
  await g.append([start(), tokenCount(reset), ledger(raw(500, 300)), tokenCount(raw(500, 300)), complete()]);
  assert.equal((await resolveCodexTurnUsage(SESSION, exactBaseline)).outputTokens, 300);
});

test('aborted usage is excluded from the next successful turn', async () => {
  const f = await fixture([meta(), start('old'), tokenCount(raw(100, 10)), event('turn_aborted', { turn_id: 'old' })]);
  const baseline = captureCodexUsageBaseline(SESSION, f.home);
  await f.append([start(), tokenCount(raw(160, 15)), complete()]);
  assert.equal((await resolveCodexTurnUsage(SESSION, baseline)).outputTokens, 5);
});

test('cancelled turns and conflicting or incomplete records fail closed', async () => {
  for (const records of [
    [start(), ledger(raw(20, 5)), event('turn_aborted', { turn_id: 'turn-1' }), complete()],
    [start(), ledger(raw(20, 5)), complete('other-turn')],
    [start(), ledger(raw(20, 5), undefined, 'other-turn'), complete()],
    [start(), ledger(raw(20, 5), raw(200, 50)), complete()],
    [start(), ledger(raw(20, 5)), ledger(raw(20, 5), raw(40, 10)), complete()],
    [start(), ledger(raw(20, 5), undefined, 'turn-1', 'r', { thread_id: OTHER }), complete()],
    [start(), ledger({ ...raw(20, 5), output_tokens: null }), complete()],
    [start(), ledger(raw(20, 5, 30)), complete()],
    [start(), tokenCount(raw(20, 5)), start('overlap'), complete('overlap')],
    [start(), tokenCount(raw(20, 5)), complete(), start('next')],
    [start(), complete()],
  ]) {
    const f = await fixture();
    const baseline = captureCodexUsageBaseline(null, f.home);
    await f.append([meta(), ...records]);
    assert.equal(await resolveCodexTurnUsage(SESSION, baseline), null);
  }
});

test('fresh fork, inherited turns, and missing resumed files never use a zero baseline', async () => {
  const f = await fixture();
  const fresh = captureCodexUsageBaseline(null, f.home);
  const missingResume = captureCodexUsageBaseline(SESSION, f.home);
  await f.append([meta({ forked_from_id: OTHER }), start(), ledger(raw(100, 10)), complete()]);
  assert.equal(await resolveCodexTurnUsage(SESSION, fresh), null);
  assert.equal(await resolveCodexTurnUsage(SESSION, missingResume), null);
  const g = await fixture([meta(), start('old'), tokenCount(raw(100, 10)), complete('old')]);
  await g.append([start(), ledger(raw(200, 20)), complete()]);
  assert.equal(await resolveCodexTurnUsage(SESSION, captureCodexUsageBaseline(null, g.home)), null);
});

test('file replacement, truncation, changed prefix, or another session/home invalidates the baseline', async () => {
  for (const mutation of ['replace', 'truncate', 'rewrite']) {
    const f = await fixture([meta(), start('old'), tokenCount(raw(100, 10)), complete('old')]);
    const baseline = captureCodexUsageBaseline(SESSION, f.home);
    if (mutation === 'replace') {
      await fs.rename(f.file, `${f.file}.old`);
      await fs.writeFile(f.file, '');
    } else if (mutation === 'truncate') {
      await fs.truncate(f.file, 0);
    } else {
      const original = await fs.readFile(f.file, 'utf8');
      await fs.writeFile(f.file, original.replaceAll('old', 'NEW'));
    }
    await f.append([start(), ledger(raw(100, 10)), complete()]);
    assert.equal(await resolveCodexTurnUsage(SESSION, baseline), null);
  }
  const f = await fixture([meta(), start('old'), tokenCount(raw(100, 10)), complete('old')]);
  const baseline = captureCodexUsageBaseline(SESSION, f.home);
  assert.equal(await resolveCodexTurnUsage(OTHER, baseline), null);
  assert.equal(await resolveCodexTurnUsage(SESSION, baseline, `${f.home}-other`), null);
});

test('long output does not lose turn boundaries and delayed flushes are retried', async () => {
  const f = await fixture();
  const baseline = captureCodexUsageBaseline(null, f.home);
  await f.append([meta(), start(), row('response_item', { text: 'x'.repeat(600 * 1024) }), ledger(raw(100, 10))]);
  const completing = new Promise((resolve, reject) => {
    setTimeout(() => f.append([complete()]).then(resolve, reject), 80);
  });
  assert.equal((await resolveCodexTurnUsage(SESSION, baseline)).outputTokens, 10);
  await completing;
});

test('missing completion and partial baseline or final JSON never produce metrics', async () => {
  const f = await fixture([meta(), start(), ledger(raw(100, 10))]);
  assert.equal(await resolveCodexTurnUsage(SESSION, captureCodexUsageBaseline(null, f.home)), null);
  await fs.appendFile(f.file, '{"type":');
  assert.equal(captureCodexUsageBaseline(SESSION, f.home).valid, false);
  assert.equal(await resolveCodexTurnUsage(SESSION, captureCodexUsageBaseline(null, f.home)), null);
});
