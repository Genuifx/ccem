import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importCoalescerModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-stream-coalescer-test-'));
  const outfile = path.join(tempDir, 'streamEventCoalescer.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'streamEventCoalescer.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function createFakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    setTimer(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, dueAt: now + delayMs });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advanceBy(durationMs) {
      const target = now + durationMs;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.dueAt;
        timer.callback();
      }
      now = target;
    },
  };
}

test('flushes from the first fragment deadline instead of extending a busy stream', async () => {
  const { createStreamEventCoalescer } = await importCoalescerModule();
  const scheduler = createFakeScheduler();
  const written = [];
  const coalescer = createStreamEventCoalescer((payload) => written.push(payload), {
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  coalescer.emit({ type: 'assistant_chunk', text: 'hello' });
  scheduler.advanceBy(39);
  coalescer.emit({ type: 'assistant_chunk', text: ' world' });
  assert.deepEqual(written, []);

  scheduler.advanceBy(1);
  assert.deepEqual(written, [{ type: 'assistant_chunk', text: 'hello world' }]);
});

test('flushes in order across stream kinds and non-stream event boundaries', async () => {
  const { createStreamEventCoalescer } = await importCoalescerModule();
  const scheduler = createFakeScheduler();
  const written = [];
  const coalescer = createStreamEventCoalescer((payload) => written.push(payload), {
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  coalescer.emit({ type: 'assistant_chunk', text: 'answer' });
  coalescer.emit({ type: 'system_message', message: 'reasoning' });
  coalescer.emit({ type: 'lifecycle', stage: 'turn_completed', detail: 'done' });

  assert.deepEqual(written, [
    { type: 'assistant_chunk', text: 'answer' },
    { type: 'system_message', message: 'reasoning' },
    { type: 'lifecycle', stage: 'turn_completed', detail: 'done' },
  ]);
});

test('only coalesces exact stream payload shapes', async () => {
  const { createStreamEventCoalescer } = await importCoalescerModule();
  const scheduler = createFakeScheduler();
  const written = [];
  const coalescer = createStreamEventCoalescer((payload) => written.push(payload), {
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });

  coalescer.emit({ type: 'assistant_chunk', text: 'plain' });
  coalescer.emit({ type: 'assistant_chunk', text: 'tagged', stream_id: 'future-protocol' });
  coalescer.emit({ type: 'assistant_chunk', text: 'tail' });
  coalescer.flush();

  assert.deepEqual(written, [
    { type: 'assistant_chunk', text: 'plain' },
    { type: 'assistant_chunk', text: 'tagged', stream_id: 'future-protocol' },
    { type: 'assistant_chunk', text: 'tail' },
  ]);
});

test('bounds buffered stream data by 4096 UTF-8 bytes', async () => {
  const { createStreamEventCoalescer } = await importCoalescerModule();
  const scheduler = createFakeScheduler();
  const written = [];
  const coalescer = createStreamEventCoalescer((payload) => written.push(payload), {
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  const almostFull = '中'.repeat(1365);
  assert.equal(Buffer.byteLength(almostFull), 4095);

  coalescer.emit({ type: 'system_message', message: almostFull });
  coalescer.emit({ type: 'system_message', message: '文' });
  assert.deepEqual(written, [{ type: 'system_message', message: almostFull }]);

  scheduler.advanceBy(40);
  assert.deepEqual(written, [
    { type: 'system_message', message: almostFull },
    { type: 'system_message', message: '文' },
  ]);
});
