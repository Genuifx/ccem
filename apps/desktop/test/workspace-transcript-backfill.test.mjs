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

function event(seq, message = `event-${seq}`) {
  return {
    runtime_id: 'runtime-paged',
    seq,
    occurred_at: `2026-08-29T00:00:${String(seq).padStart(2, '0')}Z`,
    payload: { type: 'system_message', message },
  };
}

function isCompleteReplay(batch) {
  if (
    batch.source_available === false
    || batch.gap_detected
    || batch.truncated
  ) {
    return false;
  }
  if (batch.oldest_available_seq == null || batch.newest_available_seq == null) {
    return batch.events.length === 0;
  }
  return batch.events.length === batch.newest_available_seq - batch.oldest_available_seq + 1
    && batch.events[0]?.seq === batch.oldest_available_seq
    && batch.events[batch.events.length - 1]?.seq === batch.newest_available_seq;
}

test('paged transcript backfill treats has_more as normal progress and freezes the snapshot', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptPagedBackfill ?? missingRunner;
  const requests = [];
  let yields = 0;

  const result = await run({
    loadPage: async (afterSeq, snapshotNewestSeq) => {
      requests.push([afterSeq, snapshotNewestSeq]);
      if (afterSeq == null) {
        return {
          source_available: true,
          gap_detected: false,
          decode_failure_count: 0,
          oldest_available_seq: 1,
          snapshot_newest_seq: 5,
          next_cursor: 2,
          has_more: true,
          events: [event(1), event(2)],
        };
      }
      if (afterSeq === 2) {
        return {
          source_available: true,
          gap_detected: false,
          decode_failure_count: 0,
          oldest_available_seq: 1,
          snapshot_newest_seq: 5,
          next_cursor: 4,
          has_more: true,
          events: [event(3), event(4)],
        };
      }
      return {
        source_available: true,
        gap_detected: false,
        decode_failure_count: 0,
        oldest_available_seq: 1,
        snapshot_newest_seq: 5,
        next_cursor: 5,
        has_more: false,
        events: [event(5)],
      };
    },
    isComplete: isCompleteReplay,
    retryDelaysMs: [],
    timeoutMs: 100,
    yieldBetweenPages: async () => { yields += 1; },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.value.events.map((entry) => entry.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(requests, [[null, null], [2, 5], [4, 5]]);
  assert.equal(yields, 2);
});

test('paged incremental replay starts after the committed cursor and freezes the live tail', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptPagedBackfill ?? missingRunner;
  const coversAfter = mod.replayBatchCoversSequenceAfter;
  const requests = [];

  const result = await run({
    initialAfterSeq: 100,
    loadPage: async (afterSeq, snapshotNewestSeq) => {
      requests.push([afterSeq, snapshotNewestSeq]);
      if (snapshotNewestSeq == null) {
        return {
          source_available: true,
          gap_detected: false,
          decode_failure_count: 0,
          oversized_event_count: 0,
          oldest_available_seq: 1,
          snapshot_newest_seq: 104,
          next_cursor: 102,
          has_more: true,
          events: [event(101), event(102)],
        };
      }
      return {
        source_available: true,
        gap_detected: false,
        decode_failure_count: 0,
        oversized_event_count: 0,
        oldest_available_seq: 1,
        snapshot_newest_seq: 104,
        next_cursor: 104,
        has_more: false,
        // Event 105 arrived while paging and belongs to the next poll.
        events: [event(103), event(104)],
      };
    },
    isComplete: (batch) => coversAfter(batch, 100),
    retryDelaysMs: [],
    timeoutMs: 100,
    yieldBetweenPages: async () => {},
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(result.value.events.map((entry) => entry.seq), [101, 102, 103, 104]);
  assert.deepEqual(requests, [[100, null], [102, 104]]);
});

test('incremental range completeness treats an unchanged snapshot as an empty success', async () => {
  const mod = await importBackfillModule();
  const coversAfter = mod.replayBatchCoversSequenceAfter;

  assert.equal(coversAfter({
    source_available: true,
    gap_detected: false,
    truncated: false,
    oldest_available_seq: 1,
    newest_available_seq: 100,
    events: [],
  }, 100), true);
  assert.equal(coversAfter({
    source_available: true,
    gap_detected: true,
    truncated: true,
    oldest_available_seq: 1,
    newest_available_seq: 104,
    events: [event(103), event(104)],
  }, 100), false);
});

test('paged transcript backfill advances past unreadable rows and reports partial integrity', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptPagedBackfill ?? missingRunner;
  const requests = [];

  const result = await run({
    loadPage: async (afterSeq, snapshotNewestSeq) => {
      requests.push([afterSeq, snapshotNewestSeq]);
      if (afterSeq == null) {
        return {
          source_available: true,
          gap_detected: false,
          decode_failure_count: 2,
          oldest_available_seq: 1,
          snapshot_newest_seq: 3,
          next_cursor: 2,
          has_more: true,
          events: [],
        };
      }
      return {
        source_available: true,
        gap_detected: false,
        decode_failure_count: 0,
        oldest_available_seq: 1,
        snapshot_newest_seq: 3,
        next_cursor: 3,
        has_more: false,
        events: [event(3)],
      };
    },
    isComplete: isCompleteReplay,
    retryDelaysMs: [],
    timeoutMs: 100,
    yieldBetweenPages: async () => {},
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.value.events.map((entry) => entry.seq), [3]);
  assert.equal(result.value.truncated, true);
  assert.deepEqual(requests, [[null, null], [2, 3]]);
});

test('paged transcript backfill reports an oversized skipped event as partial', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptPagedBackfill ?? missingRunner;

  const result = await run({
    loadPage: async () => ({
      source_available: true,
      gap_detected: false,
      decode_failure_count: 0,
      oversized_event_count: 1,
      oldest_available_seq: 1,
      snapshot_newest_seq: 1,
      next_cursor: 1,
      has_more: false,
      events: [],
    }),
    // Integrity flags must remain authoritative even if a caller's structural
    // completeness predicate does not know about a newly added skip reason.
    isComplete: (batch) => batch.truncated !== true,
    retryDelaysMs: [],
    timeoutMs: 100,
    yieldBetweenPages: async () => {},
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.value.truncated, true);
});

test('hide disposition preserves a settled transcript but restarts interrupted work', async () => {
  const mod = await importBackfillModule();
  const derive = mod.deriveTranscriptBackfillHideDisposition;
  assert.equal(typeof derive, 'function');

  const runtimeId = 'runtime-paged';
  const pending = { runtimeId, generation: 7, commitId: 3 };

  assert.deepEqual(derive({
    runtimeId,
    activeRequestRuntimeId: null,
    pendingCommit: null,
    committedMarker: pending,
    rawTailSettled: true,
  }), {
    pendingCommitLanded: false,
    mustRestartInitialReplay: false,
  });

  assert.deepEqual(derive({
    runtimeId,
    activeRequestRuntimeId: runtimeId,
    pendingCommit: null,
    committedMarker: null,
    rawTailSettled: false,
  }), {
    pendingCommitLanded: false,
    mustRestartInitialReplay: true,
  });

  // The page request resolved and advanced the raw cursor, but React has not
  // committed the corresponding event update yet. Hiding here must force a
  // new bounded snapshot or the older rows would be lost permanently.
  assert.deepEqual(derive({
    runtimeId,
    activeRequestRuntimeId: null,
    pendingCommit: pending,
    committedMarker: { ...pending, commitId: 2 },
    rawTailSettled: true,
  }), {
    pendingCommitLanded: false,
    mustRestartInitialReplay: true,
  });

  assert.deepEqual(derive({
    runtimeId,
    activeRequestRuntimeId: null,
    pendingCommit: pending,
    committedMarker: pending,
    rawTailSettled: true,
  }), {
    pendingCommitLanded: true,
    mustRestartInitialReplay: false,
  });

});

test('scroll anchors are released only by their exact backfill commit', async () => {
  const mod = await importBackfillModule();
  const matches = mod.transcriptBackfillCommitMatches;
  assert.equal(typeof matches, 'function');

  const expected = { runtimeId: 'runtime-paged', generation: 4, commitId: 9 };
  assert.equal(matches(expected, null), false);
  assert.equal(matches(expected, { ...expected, commitId: 8 }), false);
  assert.equal(matches(expected, { ...expected, generation: 5 }), false);
  assert.equal(matches(expected, expected), true);
});

test('poll cursors advance only from a committed replay marker', async () => {
  const mod = await importBackfillModule();
  const commitCursor = mod.resolveCommittedReplayCursor;
  assert.equal(typeof commitCursor, 'function');

  assert.equal(commitCursor(1200, 21_238, false), 21_238);
  assert.equal(commitCursor(21_238, 21_000, false), 21_238);
  assert.equal(commitCursor(21_238, null, true), null);
});

test('paged transcript backfill retries only the failed cursor page', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptPagedBackfill ?? missingRunner;
  let firstPageCalls = 0;
  let secondPageCalls = 0;

  const result = await run({
    loadPage: async (afterSeq) => {
      if (afterSeq == null) {
        firstPageCalls += 1;
        return {
          source_available: true,
          gap_detected: false,
          decode_failure_count: 0,
          oldest_available_seq: 1,
          snapshot_newest_seq: 2,
          next_cursor: 1,
          has_more: true,
          events: [event(1)],
        };
      }
      secondPageCalls += 1;
      if (secondPageCalls === 1) {
        throw new Error('temporary page read failure');
      }
      return {
        source_available: true,
        gap_detected: false,
        decode_failure_count: 0,
        oldest_available_seq: 1,
        snapshot_newest_seq: 2,
        next_cursor: 2,
        has_more: false,
        events: [event(2)],
      };
    },
    isComplete: isCompleteReplay,
    retryDelaysMs: [0],
    timeoutMs: 100,
    yieldBetweenPages: async () => {},
  });

  assert.equal(result.status, 'success');
  assert.equal(firstPageCalls, 1);
  assert.equal(secondPageCalls, 2);
  assert.equal(result.attempts, 3);
});

test('paged transcript backfill recovers the 21k-event regression shape without an unbounded read', async () => {
  const mod = await importBackfillModule();
  const run = mod.runTranscriptPagedBackfill ?? missingRunner;
  const eventCount = 21_238;
  const pageLimit = 512;
  let pageCalls = 0;
  let largestPage = 0;

  const result = await run({
    loadPage: async (afterSeq, snapshotNewestSeq) => {
      pageCalls += 1;
      const snapshot = snapshotNewestSeq ?? eventCount;
      const start = (afterSeq ?? 0) + 1;
      const end = Math.min(snapshot, start + pageLimit - 1);
      const events = end >= start
        ? Array.from({ length: end - start + 1 }, (_, index) => event(start + index))
        : [];
      largestPage = Math.max(largestPage, events.length);
      return {
        source_available: true,
        gap_detected: false,
        decode_failure_count: 0,
        oldest_available_seq: 1,
        snapshot_newest_seq: snapshot,
        next_cursor: events[events.length - 1]?.seq ?? afterSeq,
        has_more: end < snapshot,
        events,
      };
    },
    isComplete: isCompleteReplay,
    retryDelaysMs: [],
    timeoutMs: 100,
    yieldBetweenPages: async () => {},
  });

  assert.equal(result.status, 'success');
  assert.equal(result.value.events.length, eventCount);
  assert.equal(result.value.events[0].seq, 1);
  assert.equal(result.value.events[eventCount - 1].seq, eventCount);
  assert.equal(pageCalls, Math.ceil(eventCount / pageLimit));
  assert.equal(largestPage, pageLimit);
});

test('native workspace live and history recovery both use the bounded page command', async () => {
  const nativeViewSource = await fs.readFile(path.join(
    desktopDir,
    'src',
    'components',
    'workspace',
    'WorkspaceNativeSessionView.tsx',
  ), 'utf8');
  const workspaceSource = await fs.readFile(path.join(
    desktopDir,
    'src',
    'pages',
    'Workspace.tsx',
  ), 'utf8');

  assert.match(nativeViewSource, /runTranscriptPagedBackfill\(\{/);
  assert.match(nativeViewSource, /getNativeSessionEventPage\(/);
  assert.match(nativeViewSource, /deriveTranscriptBackfillHideDisposition\(\{/);
  assert.match(nativeViewSource, /initialAfterSeq: sinceSeq/);
  assert.match(nativeViewSource, /const pollEvents = useCallback\(\(\): Promise<boolean>/);
  assert.match(nativeViewSource, /setPollReplayCommitMarker/);
  assert.match(nativeViewSource, /lastSeenSeqRef\.current = resolveCommittedReplayCursor\(/);
  assert.match(
    nativeViewSource,
    /transcriptPartialObservationRef\.current\s*=\s*pendingTranscriptPartialObservationRef\.current\.observation/,
  );
  assert.match(
    nativeViewSource,
    /incrementalReplay\?\.state === 'partial'\s*&& !transcriptBackfillCommitMatches\(\s*pendingTranscriptPartialObservationRef\.current,\s*commitMarker,/,
  );
  const pollMarkerEffect = nativeViewSource.slice(
    nativeViewSource.indexOf('const marker = pollReplayCommitMarker'),
    nativeViewSource.indexOf('const isRuntimeRequestCurrent = useCallback'),
  );
  assert.doesNotMatch(
    pollMarkerEffect,
    /markTranscriptPartialObservation\(/,
    'a stale poll marker must not revive an integrity warning cleared by a covering full replay',
  );
  const pollImplementation = nativeViewSource.slice(
    nativeViewSource.indexOf('const runPollEvents = useCallback'),
    nativeViewSource.indexOf('const pollEvents = useCallback'),
  );
  assert.doesNotMatch(
    pollImplementation,
    /lastSeenSeqRef\.current\s*=/,
    'poll responses must not advance the cursor before their React commit lands',
  );
  assert.doesNotMatch(
    nativeViewSource,
    /getNativeSessionEvents\(\s*session\.runtime_id,\s*sinceSeq,\s*null/,
  );
  assert.match(nativeViewSource, /transcriptBackfillCommitPendingRef/);
  assert.match(nativeViewSource, /setTranscriptBackfillCommitMarker/);
  assert.match(
    nativeViewSource,
    /\[isVisible, transcriptBackfillCommitMarker\]/,
  );
  assert.doesNotMatch(
    nativeViewSource,
    /getNativeSessionEvents\(requestScope\.runtimeId,\s*null,\s*null\)/,
  );
  assert.match(workspaceSource, /runTranscriptPagedBackfill\(\{/);
  assert.match(workspaceSource, /getNativeSessionEventPage\(/);
  assert.doesNotMatch(
    workspaceSource,
    /getNativeSessionEvents\(nativeSession\.runtime_id,\s*null,\s*null\)/,
  );
  assert.match(
    workspaceSource,
    /integrity: result\.status === 'partial' \? 'partial' : 'complete'/,
  );
  assert.match(
    workspaceSource,
    /if \(providerHasTranscript\) \{\s*setHistoryTranscriptBackfillState\('idle'\);\s*return;/,
  );
  assert.match(workspaceSource, /preserveActiveRequest: true/);
  assert.match(
    workspaceSource,
    /preserveActiveRequest\s*&& \(conversationLoadAbortRef\.current \|\| isLoadingMessagesRef\.current\)/,
  );
  const providerFirstPaint = workspaceSource.indexOf(
    'providerHistory = await fetchConversationDetail(session)',
  );
  const nativeHistorySettle = workspaceSource.indexOf(
    'const nativeHistoryResult = await nativeHistoryPromise',
  );
  assert.ok(providerFirstPaint >= 0 && providerFirstPaint < nativeHistorySettle);
});

test('historical prepend does not animate every recovered transcript item', async () => {
  const source = await fs.readFile(path.join(
    desktopDir,
    'src',
    'components',
    'workspace',
    'WorkspaceTranscriptList.tsx',
  ), 'utf8');

  assert.match(source, /const isTailAppend =/);
  assert.match(source, /slice\(-12\)/);
  assert.match(source, /const newKeySet = new Set\(newKeys\)/);
  assert.doesNotMatch(source, /newKeys\.includes\(/);
});

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

test('full replay preserves a partial poll response whose React marker has not committed yet', async () => {
  const mod = await importBackfillModule();
  const includePending = mod.includePendingTranscriptPartialObservation
    ?? ((committed) => committed);
  const markPartial = mod.markTranscriptPartialObservation ?? (() => ({ version: -1 }));
  const resolvePresentation = mod.resolveTranscriptBackfillPresentation
    ?? (() => ({ state: 'missing' }));
  const requestScope = { runtimeId: 'runtime-interleaved', generation: 4 };
  const beforeFullRequest = {
    version: 0,
    throughSeq: null,
    unknownRange: false,
  };
  const pendingPartial = {
    ...requestScope,
    commitId: 7,
    observation: markPartial(beforeFullRequest, 11),
  };

  // The incremental response has resolved, but its low-priority React marker
  // has not committed yet. A full snapshot through seq 10 must still see it.
  const observationAtFullResolution = includePending(
    beforeFullRequest,
    pendingPartial,
    requestScope,
  );
  const staleFullSuccess = resolvePresentation(
    'success',
    10,
    beforeFullRequest.version,
    observationAtFullResolution,
  );
  assert.equal(staleFullSuccess.state, 'partial');
  assert.deepEqual(staleFullSuccess.partialObservation, pendingPartial.observation);

  assert.deepEqual(
    includePending(beforeFullRequest, pendingPartial, {
      runtimeId: requestScope.runtimeId,
      generation: requestScope.generation + 1,
    }),
    beforeFullRequest,
    'a hidden or switched runtime generation must not inherit an uncommitted partial',
  );
});

test('covering full replay is not reverted by its queued stale partial marker', async () => {
  const mod = await importBackfillModule();
  const includePending = mod.includePendingTranscriptPartialObservation
    ?? ((committed) => committed);
  const markPartial = mod.markTranscriptPartialObservation ?? (() => ({ version: -1 }));
  const resolvePresentation = mod.resolveTranscriptBackfillPresentation
    ?? (() => ({ state: 'missing' }));
  const markerMatches = mod.transcriptBackfillCommitMatches ?? (() => true);
  const requestScope = { runtimeId: 'runtime-covered', generation: 9 };
  const beforeFullRequest = {
    version: 0,
    throughSeq: null,
    unknownRange: false,
  };
  const acceptedPartial = markPartial(beforeFullRequest, 11);
  const queuedPartialMarker = {
    ...requestScope,
    commitId: 12,
    observation: acceptedPartial,
  };

  const coveringFullSuccess = resolvePresentation(
    'success',
    11,
    beforeFullRequest.version,
    includePending(acceptedPartial, queuedPartialMarker, requestScope),
  );
  assert.equal(coveringFullSuccess.state, 'idle');
  assert.equal(coveringFullSuccess.partialObservation.throughSeq, null);

  // A covering success clears this pending slot. Both the queued view update
  // and marker effect are then observation-neutral for the stale marker.
  const pendingAfterCoveringFull = null;
  assert.equal(markerMatches(pendingAfterCoveringFull, queuedPartialMarker), false);
  const finalViewState = markerMatches(pendingAfterCoveringFull, queuedPartialMarker)
    ? 'partial'
    : coveringFullSuccess.state;
  assert.equal(finalViewState, 'idle');
  assert.deepEqual(coveringFullSuccess.partialObservation, {
    version: acceptedPartial.version,
    throughSeq: null,
    unknownRange: false,
  });
});
