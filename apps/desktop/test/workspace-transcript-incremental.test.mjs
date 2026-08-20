import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function transcribe(...parts) {
  return fs.readFile(path.join(desktopDir, ...parts), 'utf8');
}

async function importTranscriptModule() {
  const [source, identitySource] = await Promise.all([
    transcribe('src', 'components', 'workspace', 'workspaceEventTranscript.ts'),
    transcribe('src', 'components', 'workspace', 'transcriptIdentity.ts'),
  ]);
  const compile = (text) => ts.transpileModule(text, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-transcript-incremental-'));
  const outputPath = path.join(tempDir, 'workspaceEventTranscript.mjs');
  const identityPath = path.join(tempDir, 'transcriptIdentity.mjs');
  await fs.writeFile(
    outputPath,
    compile(source).replace("from './transcriptIdentity'", "from './transcriptIdentity.mjs'"),
    'utf8',
  );
  await fs.writeFile(identityPath, compile(identitySource), 'utf8');
  return import(pathToFileURL(outputPath).href);
}

const RUNTIME_ID = 'runtime-incremental';
const BASE_TS = Date.UTC(2026, 7, 1, 0, 0, 0);

function ev(seq, payload) {
  return {
    runtime_id: RUNTIME_ID,
    seq,
    occurred_at: new Date(BASE_TS + seq * 1000).toISOString(),
    payload,
  };
}

/**
 * Deterministic conversational fixture: turns of ten events each.
 * 1 user_prompt, 2 lifecycle(turn_started), 3-5 assistant_chunk,
 * 6 tool_use_started, 7 tool_use_completed, 8 system_message,
 * 9 token_usage, 10 lifecycle(turn_completed).
 */
function buildFixture(count) {
  const events = [];
  let seq = 0;
  let turn = 0;
  while (seq < count) {
    turn += 1;
    const toolUseId = `tool-${turn}`;
    const turnEvents = [
      { type: 'user_prompt', text: `prompt ${turn}` },
      { type: 'lifecycle', stage: 'turn_started' },
      { type: 'assistant_chunk', text: `answer ${turn} part one. ` },
      { type: 'assistant_chunk', text: `part two. ` },
      { type: 'assistant_chunk', text: `part three.` },
      {
        type: 'tool_use_started',
        tool_use_id: toolUseId,
        raw_name: 'Read',
        input_summary: 'src/main.ts',
        needs_response: false,
        category: { category: 'file_op', raw_name: 'Read' },
      },
      {
        type: 'tool_use_completed',
        tool_use_id: toolUseId,
        raw_name: 'Read',
        result_content: 'file body',
        result_summary: 'file body',
        success: true,
      },
      { type: 'system_message', message: `thinking about turn ${turn}` },
      {
        type: 'token_usage',
        scope: 'turn_total',
        provider: 'claude',
        input_tokens: 100 * turn,
        output_tokens: 10 * turn,
        cache_read_tokens: 5 * turn,
        cache_creation_tokens: 2 * turn,
      },
      { type: 'lifecycle', stage: 'turn_completed' },
    ];
    for (const payload of turnEvents) {
      if (seq >= count) {
        break;
      }
      seq += 1;
      events.push(ev(seq, payload));
    }
  }
  return events;
}

function baseMessages() {
  return [{
    msgType: 'assistant',
    uuid: 'seed-1',
    content: 'seed context',
    timestamp: BASE_TS - 1000,
    segmentIndex: 0,
    isCompactBoundary: false,
  }];
}

test('incremental append equals one-shot derivation of all events', async () => {
  const mod = await importTranscriptModule();
  const events = buildFixture(50);
  const appended = buildFixture(55).slice(50);

  const state = mod.deriveTranscriptReset(baseMessages(), [], events, null);
  const incremented = mod.deriveTranscriptAppend(state, appended);
  const incrementalMessages = mod.finalizeTranscriptMessages(incremented);
  const oneShot = mod.buildMessagesFromEvents(baseMessages(), [], [...events, ...appended], null);

  assert.deepEqual(incrementalMessages, oneShot);
});

test('appended events reuse prior message object identities', async () => {
  const mod = await importTranscriptModule();
  const events = buildFixture(50);
  const state = mod.deriveTranscriptReset(baseMessages(), [], events, null);
  const before = mod.finalizeTranscriptMessages(state);

  // Case 1: append lands after a closed turn (user_prompt starts turn 6).
  const nextTurn = mod.deriveTranscriptAppend(state, buildFixture(55).slice(50));
  const afterNextTurn = mod.finalizeTranscriptMessages(nextTurn);
  assert.ok(afterNextTurn.length > before.length);
  for (let index = 0; index < before.length; index += 1) {
    assert.ok(
      before[index] === afterNextTurn[index],
      `message ${index} must keep identity across a clean-turn append`,
    );
  }

  // Case 2: append continues an OPEN streaming turn (mid-chunk boundary).
  const streamState = mod.deriveTranscriptReset(baseMessages(), [], buildFixture(53), null);
  const streamBefore = mod.finalizeTranscriptMessages(streamState);
  const streamAfter = mod.finalizeTranscriptMessages(
    mod.deriveTranscriptAppend(streamState, buildFixture(55).slice(53)),
  );
  assert.equal(streamAfter.length, streamBefore.length);
  // The flushed streaming message (last) is rebuilt; everything above it is
  // carried forward by construction — at least the first half must be `toBe`.
  const stableCount = streamBefore.length - 1;
  assert.ok(stableCount >= Math.floor(streamBefore.length / 2));
  for (let index = 0; index < stableCount; index += 1) {
    assert.ok(
      streamBefore[index] === streamAfter[index],
      `streaming message ${index} must keep identity`,
    );
  }
});

test('non-extension event lists fall back to reset and still equal one-shot', async () => {
  const mod = await importTranscriptModule();
  const events = buildFixture(50);
  const state = mod.deriveTranscriptReset(baseMessages(), [], events, null);

  // Marker missing: a shorter replacement list is a reset, not an append.
  const shortened = events.slice(0, 40);
  let selection = mod.selectTranscriptAppendEvents(shortened, state);
  assert.equal(selection.mode, 'reset');
  assert.deepEqual(
    mod.finalizeTranscriptMessages(
      mod.deriveTranscriptReset(baseMessages(), [], shortened, null),
    ),
    mod.buildMessagesFromEvents(baseMessages(), [], shortened, null),
  );

  // Merge-insert: older events refilled below the consumed marker.
  const originalWithHole = [
    ...buildFixture(25),
    ...buildFixture(54).slice(29), // seqs 30..54, hole at 26..29
  ];
  assert.equal(originalWithHole.length, 50);
  const holedState = mod.deriveTranscriptReset(baseMessages(), [], originalWithHole, null);
  const merged = buildFixture(59);
  selection = mod.selectTranscriptAppendEvents(merged, holedState);
  assert.equal(selection.mode, 'reset');
  assert.deepEqual(
    mod.finalizeTranscriptMessages(
      mod.deriveTranscriptReset(baseMessages(), [], merged, null),
    ),
    mod.buildMessagesFromEvents(baseMessages(), [], merged, null),
  );

  // Pruning from the head is NOT a reset: the derivation keeps its messages.
  const prunedHead = events.slice(10);
  selection = mod.selectTranscriptAppendEvents(prunedHead, state);
  assert.ok(selection.mode === 'idle' || selection.mode === 'append');
});

test('gap inside appended events still emits the transcript gap summary', async () => {
  const mod = await importTranscriptModule();
  const events = buildFixture(50);
  const state = mod.deriveTranscriptReset(baseMessages(), [], events, null);
  const appendedWithHole = buildFixture(60).slice(55); // seqs 56..60, hole at 51..55

  const gapped = mod.finalizeTranscriptMessages(
    mod.deriveTranscriptAppend(state, appendedWithHole),
  );
  const oneShot = mod.buildMessagesFromEvents(
    baseMessages(),
    [],
    [...events, ...appendedWithHole],
    null,
  );
  assert.deepEqual(gapped, oneShot);
  assert.ok(gapped.some(
    (message) => message.summary === mod.TRANSCRIPT_GAP_SUMMARY_TOKEN,
    'gap summary must be present for a real hole',
  ));
});

test('head rebase and terminal error finalize without refolding', async () => {
  const mod = await importTranscriptModule();
  const events = buildFixture(50);
  const seed = baseMessages();
  const prompts = [{
    id: 'initial-user',
    text: 'prompt 1',
    timestamp: BASE_TS + 500,
  }];
  const tokens = { seedMessages: seed, prompts: { token: 1 } };

  const state = mod.deriveTranscriptReset(
    mod.buildBaseMessages(seed, prompts[0]),
    [prompts[0]],
    events,
    null,
    { tokens },
  );
  const before = mod.finalizeTranscriptMessages(state);
  assert.ok(before.some((message) => typeof message.content === 'string' && message.content === 'prompt 1'));

  // Prompt confirmed + seed replaced: rebase rebuilds only the head.
  const rebased = mod.rebaseTranscriptHead(
    state,
    mod.buildBaseMessages(seed, undefined),
    events,
    [],
    { seedMessages: seed, prompts: { token: 2 } },
  );
  const afterRebase = mod.finalizeTranscriptMessages(rebased);
  // Seed head retained, event-derived tail identities preserved.
  const headEnd = rebased.headLength;
  for (let index = headEnd; index < afterRebase.length; index += 1) {
    const beforeIndex = index - (afterRebase.length - before.length);
    if (beforeIndex >= 0 && beforeIndex < before.length) {
      assert.ok(afterRebase[index] === before[beforeIndex]);
    }
  }

  // Terminal error is finalize-only: state messages do not change.
  const withError = { ...rebased, terminalError: 'runtime exploded' };
  assert.equal(withError.messages.length, rebased.messages.length);
  const finalized = mod.finalizeTranscriptMessages(withError);
  assert.equal(finalized[finalized.length - 1].content, 'runtime exploded');
});
