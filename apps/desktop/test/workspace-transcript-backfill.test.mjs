import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importBackfillModule() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'workspace',
    'workspaceTranscriptBackfill.ts',
  );
  let source;
  try {
    source = await fs.readFile(sourcePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-transcript-backfill-'));
  const outputPath = path.join(tempDir, 'workspaceTranscriptBackfill.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function missingRunner() {
  return Promise.resolve({ status: 'missing', attempts: 0 });
}

test('transcript backfill retries one rejected read and returns the complete replay', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptBackfillWithRetry ?? missingRunner;
  let calls = 0;
  const expectedBatch = { complete: true, marker: 'full-history' };

  const result = await run({
    load: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('temporary sqlite read failure');
      }
      return expectedBatch;
    },
    isComplete: (batch) => batch.complete,
    retryDelaysMs: [0, 0],
    timeoutMs: 100,
  });

  assert.deepEqual(result, {
    status: 'success',
    attempts: 2,
    value: expectedBatch,
  });
  assert.equal(calls, 2);
});

test('transcript backfill returns a completed but incomplete full replay without retrying', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptBackfillWithRetry ?? missingRunner;
  let calls = 0;

  const result = await run({
    load: async () => {
      calls += 1;
      return { complete: false };
    },
    isComplete: (batch) => batch.complete,
    retryDelaysMs: [0, 0],
    timeoutMs: 100,
  });

  assert.deepEqual(result, {
    status: 'partial',
    attempts: 1,
    value: { complete: false },
  });
  assert.equal(calls, 1);
});

test('transcript backfill times out without stacking another physical load', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptBackfillWithRetry ?? missingRunner;
  let calls = 0;

  const result = await run({
    load: () => {
      calls += 1;
      return new Promise(() => {});
    },
    isComplete: () => true,
    retryDelaysMs: [0, 0],
    timeoutMs: 5,
  });

  assert.equal(result.status, 'error');
  assert.equal(result.attempts, 1);
  assert.match(String(result.error), /timed out/i);
  assert.equal(calls, 1);
});

test('retrying a timed-out runtime reuses its still-pending physical read', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptBackfillWithRetry ?? missingRunner;
  let calls = 0;
  let resolveLoad;
  const expectedBatch = { complete: true, marker: 'late-full-history' };
  const physicalRead = new Promise((resolve) => {
    resolveLoad = resolve;
  });
  const options = {
    load: () => {
      calls += 1;
      return physicalRead;
    },
    isComplete: (batch) => batch.complete,
    physicalRequestKey: 'runtime-timeout-retry',
    retryDelaysMs: [],
  };

  const firstResult = await run({ ...options, timeoutMs: 5 });
  assert.equal(firstResult.status, 'error');
  assert.equal(calls, 1);

  const retryResultPromise = run({ ...options, timeoutMs: 100 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1, 'Retry must not start a second physical replay');

  resolveLoad(expectedBatch);
  assert.deepEqual(await retryResultPromise, {
    status: 'success',
    attempts: 1,
    value: expectedBatch,
  });
  assert.equal(calls, 1);
});

test('a timed-out physical read releases its runtime lease after rejection', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptBackfillWithRetry ?? missingRunner;
  let calls = 0;
  let rejectFirstLoad;
  const firstRead = new Promise((_, reject) => {
    rejectFirstLoad = reject;
  });
  const load = () => {
    calls += 1;
    return calls === 1
      ? firstRead
      : Promise.resolve({ complete: true, marker: 'fresh-read' });
  };
  const request = {
    load,
    isComplete: (batch) => batch.complete,
    physicalRequestKey: 'runtime-timeout-reject',
    retryDelaysMs: [],
  };

  const firstResult = await run({ ...request, timeoutMs: 5 });
  assert.equal(firstResult.status, 'error');
  assert.equal(calls, 1);

  rejectFirstLoad(new Error('late sqlite failure'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const retryResult = await run({ ...request, timeoutMs: 100 });
  assert.deepEqual(retryResult, {
    status: 'success',
    attempts: 1,
    value: { complete: true, marker: 'fresh-read' },
  });
  assert.equal(calls, 2);
});

test('physical replay leases are scoped per runtime', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptBackfillWithRetry ?? missingRunner;
  let resolveRuntimeA;
  let runtimeACalls = 0;
  let runtimeBCalls = 0;
  const runtimeARead = new Promise((resolve) => {
    resolveRuntimeA = resolve;
  });

  const runtimeAResult = await run({
    load: () => {
      runtimeACalls += 1;
      return runtimeARead;
    },
    isComplete: (batch) => batch.complete,
    physicalRequestKey: 'runtime-a-switch',
    retryDelaysMs: [],
    timeoutMs: 5,
  });
  assert.equal(runtimeAResult.status, 'error');

  const runtimeBResult = await run({
    load: async () => {
      runtimeBCalls += 1;
      return { complete: true, marker: 'runtime-b' };
    },
    isComplete: (batch) => batch.complete,
    physicalRequestKey: 'runtime-b-switch',
    retryDelaysMs: [],
    timeoutMs: 100,
  });
  assert.equal(runtimeBResult.status, 'success');
  assert.equal(runtimeACalls, 1);
  assert.equal(runtimeBCalls, 1);

  resolveRuntimeA({ complete: true, marker: 'runtime-a' });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('transcript backfill cancellation prevents a stale runtime retry', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptBackfillWithRetry ?? missingRunner;
  const controller = new AbortController();
  let calls = 0;

  const pending = run({
    load: async () => {
      calls += 1;
      throw new Error('retryable failure');
    },
    isComplete: () => true,
    retryDelaysMs: [50, 50],
    timeoutMs: 100,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);

  const result = await pending;
  assert.deepEqual(result, { status: 'cancelled', attempts: 1 });
  assert.equal(calls, 1);
});

test('complete replay replaces stale cached rows while preserving newer live events', async () => {
  const mod = await importBackfillModule();
  const reconcile = mod.reconcileCompleteReplayEvents ?? (() => []);
  const event = (runtimeId, seq, message) => ({
    runtime_id: runtimeId,
    seq,
    occurred_at: `2026-08-27T00:00:0${seq}Z`,
    payload: { type: 'system_message', message },
  });

  const completeReplay = [
    event('runtime-a', 1, 'authoritative-1'),
    event('runtime-a', 2, 'authoritative-2'),
    event('runtime-a', 3, 'authoritative-3'),
  ];
  const currentEvents = [
    event('runtime-a', 1, 'cached-1'),
    event('runtime-a', 2, 'stale-cached-2'),
    event('runtime-a', 4, 'live-after-snapshot'),
    event('runtime-b', 5, 'different-runtime'),
  ];

  assert.deepEqual(
    reconcile(completeReplay, currentEvents),
    [...completeReplay, currentEvents[2]],
  );
});

test('partial replay stays visible and preserves the readable tail when no rows decode', async () => {
  const mod = await importBackfillModule();
  const resolveReplay = mod.resolveTranscriptBackfillReplay ?? (() => ({ state: 'missing' }));
  const event = (seq, message) => ({
    runtime_id: 'runtime-partial',
    seq,
    occurred_at: `2026-08-27T00:00:0${seq}Z`,
    payload: { type: 'system_message', message },
  });
  const readableTail = [event(7, 'cached-readable-tail')];

  const resolution = resolveReplay('partial', {
    gap_detected: false,
    truncated: true,
    oldest_available_seq: 1,
    newest_available_seq: 7,
    events: [],
  }, readableTail);

  assert.equal(resolution.state, 'partial');
  assert.equal(resolution.rawTailSettled, true);
  assert.equal(
    resolution.clearProvisionalGaps,
    false,
    'cached seam suppression stays intact when the full read decoded nothing',
  );
  assert.deepEqual(resolution.events, readableTail);
});

test('partial replay adopts decoded rows without reviving stale rows inside its snapshot', async () => {
  const mod = await importBackfillModule();
  const resolveReplay = mod.resolveTranscriptBackfillReplay ?? (() => ({ state: 'missing' }));
  const event = (seq, message) => ({
    runtime_id: 'runtime-partial-snapshot',
    seq,
    occurred_at: `2026-08-27T00:00:${String(seq).padStart(2, '0')}Z`,
    payload: { type: 'system_message', message },
  });
  const decoded = [event(1, 'decoded-1'), event(3, 'decoded-3')];
  const staleInsideSnapshot = event(4, 'stale-cached-4');
  const newerLiveEvent = event(5, 'new-live-5');

  const resolution = resolveReplay('partial', {
    gap_detected: false,
    truncated: true,
    oldest_available_seq: 1,
    newest_available_seq: 4,
    events: decoded,
  }, [event(1, 'old-cache-1'), staleInsideSnapshot, newerLiveEvent]);

  assert.equal(resolution.state, 'partial');
  assert.equal(resolution.clearProvisionalGaps, true);
  assert.deepEqual(resolution.events, [...decoded, newerLiveEvent]);
});

test('unavailable persisted replay merges readable memory fallback into cached history', async () => {
  const mod = await importBackfillModule();
  const resolveReplay = mod.resolveTranscriptBackfillReplay ?? (() => ({ state: 'missing' }));
  const event = (seq, message) => ({
    runtime_id: 'runtime-memory-fallback',
    seq,
    occurred_at: `2026-08-27T00:00:${String(seq).padStart(2, '0')}Z`,
    payload: { type: 'system_message', message },
  });
  const cachedHistory = [event(1, 'cached-1'), event(2, 'cached-2')];
  const fallbackTail = [event(2, 'fallback-2'), event(3, 'fallback-3')];

  const resolution = resolveReplay('partial', {
    source_available: false,
    gap_detected: false,
    truncated: true,
    oldest_available_seq: 2,
    newest_available_seq: 3,
    events: fallbackTail,
  }, cachedHistory);

  assert.equal(resolution.state, 'partial');
  assert.equal(resolution.clearProvisionalGaps, false);
  assert.equal(resolution.rawTailSettled, false);
  assert.deepEqual(resolution.events, [cachedHistory[0], ...fallbackTail]);
});

test('queued full replay update reconciles against the latest committed live tail', async () => {
  const mod = await importBackfillModule();
  const createUpdate = mod.createTranscriptBackfillEventUpdate ?? (() => () => []);
  const event = (seq, message) => ({
    runtime_id: 'runtime-interleaved',
    seq,
    occurred_at: `2026-08-27T00:00:${String(seq).padStart(2, '0')}Z`,
    payload: { type: 'system_message', message },
  });
  const fullBatch = {
    gap_detected: false,
    truncated: false,
    oldest_available_seq: 1,
    newest_available_seq: 2,
    events: [event(1, 'full-1'), event(2, 'full-2')],
  };
  const queuedUpdate = createUpdate('success', fullBatch);
  const stateAfterPollingCommitted = [event(1, 'cached-1'), event(3, 'live-3')];

  assert.deepEqual(
    queuedUpdate(stateAfterPollingCommitted),
    [...fullBatch.events, stateAfterPollingCommitted[1]],
  );
});

test('empty authoritative snapshot clears old cache but preserves events queued after request start', async () => {
  const mod = await importBackfillModule();
  const createUpdate = mod.createTranscriptBackfillEventUpdate ?? (() => () => []);
  const event = (seq, message) => ({
    runtime_id: 'runtime-empty-interleaved',
    seq,
    occurred_at: `2026-08-27T00:00:${String(seq).padStart(2, '0')}Z`,
    payload: { type: 'system_message', message },
  });
  const emptySnapshot = {
    gap_detected: false,
    truncated: false,
    oldest_available_seq: null,
    newest_available_seq: null,
    events: [],
  };
  const update = createUpdate('success', emptySnapshot, 2);
  const liveAfterRequest = event(3, 'live-after-request');

  assert.deepEqual(
    update([event(1, 'stale-cache'), liveAfterRequest]),
    [liveAfterRequest],
  );
});

test('incremental replay metadata surfaces unreadable tail rows and advances past them', async () => {
  const mod = await importBackfillModule();
  const inspect = mod.inspectIncrementalTranscriptReplay ?? (() => ({ state: 'missing' }));

  assert.deepEqual(inspect({
    gap_detected: false,
    truncated: true,
    oldest_available_seq: 1,
    newest_available_seq: 8,
    events: [],
  }), {
    state: 'partial',
    acknowledgedSeq: 8,
  });

  assert.deepEqual(inspect({
    gap_detected: false,
    truncated: true,
    oldest_available_seq: 1,
    newest_available_seq: 9,
    events: [
      { runtime_id: 'runtime-tail', seq: 7, occurred_at: '', payload: {} },
      { runtime_id: 'runtime-tail', seq: 9, occurred_at: '', payload: {} },
    ],
  }), {
    state: 'partial',
    acknowledgedSeq: 9,
  });

  assert.deepEqual(inspect({
    gap_detected: false,
    truncated: false,
    oldest_available_seq: 1,
    newest_available_seq: 9,
    events: [],
  }), {
    state: 'idle',
    acknowledgedSeq: null,
  });

  assert.deepEqual(inspect({
    source_available: false,
    gap_detected: false,
    truncated: false,
    oldest_available_seq: null,
    newest_available_seq: null,
    events: [],
  }), {
    state: 'partial',
    acknowledgedSeq: null,
  });
});

test('older successful snapshot cannot clear a newer incremental partial observation', async () => {
  const mod = await importBackfillModule();
  const markPartial = mod.markTranscriptPartialObservation ?? (() => ({ version: -1 }));
  const resolvePresentation = mod.resolveTranscriptBackfillPresentation
    ?? (() => ({ state: 'missing' }));
  const beforeRequest = { version: 0, throughSeq: null };
  const observedAfterRequest = markPartial(beforeRequest, 11);

  const staleSuccess = resolvePresentation(
    'success',
    10,
    beforeRequest.version,
    observedAfterRequest,
  );
  assert.equal(staleSuccess.state, 'partial');
  assert.deepEqual(staleSuccess.partialObservation, observedAfterRequest);

  const coveringSuccess = resolvePresentation(
    'success',
    11,
    beforeRequest.version,
    observedAfterRequest,
  );
  assert.equal(coveringSuccess.state, 'idle');
  assert.equal(coveringSuccess.partialObservation.throughSeq, null);

  const unknownRange = markPartial(beforeRequest, null);
  const successWithLargerCursor = resolvePresentation(
    'success',
    999,
    beforeRequest.version,
    unknownRange,
  );
  assert.equal(successWithLargerCursor.state, 'partial');
  assert.equal(successWithLargerCursor.partialObservation.unknownRange, true);
});
