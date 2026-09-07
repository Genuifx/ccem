import * as fsPromises from 'fs/promises';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', { spy: true });

const model = 'claude-sonnet-4-5';
const timestamp = new Date().toISOString();
const tokens = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 0 };
const message = (id?: unknown, text = 'block 1') => ({
  type: 'assistant', timestamp,
  message: {
    id, model,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
    content: [{ type: 'text', text }],
  },
});

describe('JSONL usage accounting', () => {
  let home: string;
  let project: string;
  let cachePath: string;
  let usage: typeof import('../usage.js');

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ccem-usage-test-'));
    project = join(home, '.claude', 'projects', 'synthetic');
    cachePath = join(home, '.ccem', 'usage-cache.json');
    await mkdir(project, { recursive: true });
    await mkdir(join(home, '.ccem'));
    vi.resetModules();
    vi.doMock('os', () => ({ homedir: () => home }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ [model]: {
        input_cost_per_token: 3e-6, output_cost_per_token: 15e-6,
        cache_read_input_token_cost: 0.3e-6, cache_creation_input_token_cost: 3.75e-6,
      } }),
    }));
    usage = await import('../usage.js');
  });

  afterEach(async () => {
    vi.doUnmock('os');
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  async function writeSession(rows: unknown[], name = 'session.jsonl') {
    const file = join(project, name);
    await writeFile(file, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
    return file;
  }

  async function readStats() {
    const writes = vi.mocked(fsPromises.writeFile);
    writes.mockClear();
    const result = await usage.getUsageStats();
    await vi.waitFor(() => expect(writes.mock.calls.some(([file]) => file === cachePath)).toBe(true));
    await Promise.all(writes.mock.results.map(result => result.value));
    // The production API saves asynchronously; wait before reading or removing its cache.
    await vi.waitFor(async () => {
      const cache = JSON.parse(await readFile(cachePath, 'utf8'));
      expect(cache.lastUpdated).toBeTruthy();
      expect(usage.getUsageStatsFromCache()?.total).toEqual(result.total);
    });
    return result;
  }

  it('counts two content blocks of one response once in every aggregate and the cache', async () => {
    await writeSession([message('msg_same'), message('msg_same', 'block 2')]);
    const stats = await readStats();
    for (const total of [stats.total, stats.today, stats.week, stats.byModel[model], stats.dailyHistory[timestamp.split('T')[0]]]) {
      expect(total).toMatchObject(tokens);
      expect(total.cost).toBeCloseTo(0.00069, 10);
    }
    expect((await readStats()).total).toEqual(stats.total);
  });

  it('replaces a partial usage snapshot with the final snapshot, including cached reparses', async () => {
    const partial = message('msg_partial');
    partial.message.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    await writeSession([partial]);
    expect((await readStats()).total.inputTokens).toBe(0);
    await writeSession([partial, message('msg_partial')]);
    const stats = await readStats();
    expect(stats.total).toMatchObject(tokens);
    expect(stats.total.cost).toBeCloseTo(0.00069, 10);
  });

  it('counts distinct response IDs even with identical usage', async () => {
    await writeSession([message('msg_a'), message('msg_b')]);
    expect((await readStats()).total.inputTokens).toBe(200);
  });

  it('keeps per-line accounting for missing, empty, or non-string IDs', async () => {
    await writeSession([undefined, undefined, '', '', 123, 123].map(id => message(id)));
    expect((await readStats()).total.inputTokens).toBe(600);
  });

  it('does not let ignored rows consume a response ID', async () => {
    await writeSession([
      '{invalid json',
      { ...message('msg_a'), type: 'user' },
      { type: 'assistant', message: { id: 'msg_a', model } },
      message('msg_a'), message('msg_a', 'block 2'),
    ]);
    expect((await readStats()).total.inputTokens).toBe(100);
  });

  it('scopes response IDs to each file', async () => {
    await writeSession([message('msg_same'), message('msg_same')]);
    await writeSession([message('msg_same')], 'another-session.jsonl');
    expect((await readStats()).total.inputTokens).toBe(200);
  });

  it('reparses an appended file without recounting the original response', async () => {
    await writeSession([message('msg_a')]);
    await readStats();
    await writeSession([message('msg_a'), message('msg_a', 'block 2'), message('msg_b')]);
    expect((await readStats()).total.inputTokens).toBe(200);
  });

  it('rejects version 1 cache in both readers and recomputes unchanged files', async () => {
    const file = await writeSession([message('msg_same'), message('msg_same', 'block 2')]);
    const meta = await stat(file);
    const inflated = { timestamp, model, usage: { ...tokens, cost: 0.00069 } };
    await writeFile(cachePath, JSON.stringify({
      version: 1, lastUpdated: timestamp,
      files: { [file]: { meta: { mtime: meta.mtimeMs, size: meta.size }, stats: { entries: [inflated, inflated] } } },
    }));
    const initial = usage.getUsageStatsFromCache();
    const stats = await readStats();
    expect(initial).toBeNull();
    expect(stats.total.inputTokens).toBe(100);
    expect(JSON.parse(await readFile(cachePath, 'utf8')).version).toBe(2);
  });
});
