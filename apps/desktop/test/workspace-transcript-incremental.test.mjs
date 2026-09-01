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
  const [source, identitySource, attentionSource] = await Promise.all([
    transcribe('src', 'components', 'workspace', 'workspaceEventTranscript.ts'),
    transcribe('src', 'components', 'workspace', 'transcriptIdentity.ts'),
    transcribe('src', 'components', 'workspace', 'workspaceNativeAttention.ts'),
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
  const attentionPath = path.join(tempDir, 'workspaceNativeAttention.mjs');
  await fs.writeFile(
    outputPath,
    compile(source)
      .replaceAll("from './transcriptIdentity'", "from './transcriptIdentity.mjs'")
      .replaceAll("from './workspaceNativeAttention'", "from './workspaceNativeAttention.mjs'"),
    'utf8',
  );
  await fs.writeFile(identityPath, compile(identitySource), 'utf8');
  await fs.writeFile(attentionPath, compile(attentionSource), 'utf8');
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

test('limited replay suppresses only backend-proven unloaded seams, not real holes', async () => {
  const mod = await importTranscriptModule();
  const sparseReplay = [
    ev(1, { type: 'lifecycle', stage: 'runtime_boot' }),
    ev(2, { type: 'user_prompt', text: 'inspect the workspace' }),
    ev(7, {
      type: 'checkpoint_created',
      checkpoint_id: 'checkpoint-1',
      provider: 'claude',
      source: 'claude-file-checkpoint',
    }),
    ev(8170, { type: 'assistant_chunk', text: 'recent tail' }),
  ];
  const gapStarts = mod.eventSequenceGapStarts?.(sparseReplay) ?? [];

  assert.deepEqual(gapStarts, [7, 8170]);
  const unloadedGapStarts = new Set([8170]);

  const messages = mod.finalizeTranscriptMessages(
    mod.deriveTranscriptReset(
      [],
      [],
      sparseReplay,
      null,
      { suppressGapBeforeSeqs: unloadedGapStarts },
    ),
  );
  assert.equal(
    messages.filter((message) => message.summary === mod.TRANSCRIPT_GAP_SUMMARY_TOKEN).length,
    1,
  );

  const initialState = mod.deriveTranscriptReset([], [], sparseReplay.slice(0, 2));
  const incrementallyAppended = mod.finalizeTranscriptMessages(
    mod.deriveTranscriptAppend(
      initialState,
      sparseReplay.slice(2),
      unloadedGapStarts,
    ),
  );
  assert.equal(
    incrementallyAppended.filter(
      (message) => message.summary === mod.TRANSCRIPT_GAP_SUMMARY_TOKEN,
    ).length,
    1,
  );
});

test('background-task tool completions stay suppressed across incremental appends', async () => {
  const mod = await importTranscriptModule();
  const task = (toolUseId) => ({
    task_id: `task-${toolUseId}`,
    tool_use_id: toolUseId,
    description: `background ${toolUseId}`,
    status: 'running',
    started_at: new Date(BASE_TS).toISOString(),
    updated_at: new Date(BASE_TS + 5000).toISOString(),
  });
  const events = [
    ev(1, { type: 'user_prompt', text: 'start background work' }),
    ev(2, {
      type: 'background_tasks_changed',
      tasks: [task('bg-tool-1'), task('bg-tool-2')],
    }),
    ev(3, {
      type: 'background_task_updated',
      task: { ...task('bg-tool-3'), status: 'running' },
    }),
    // Background completions that never attach to a visible block must not
    // fall through to standalone error/result rows.
    ev(4, {
      type: 'tool_use_completed',
      tool_use_id: 'bg-tool-1',
      raw_name: 'Task',
      result_summary: 'background boom',
      success: false,
    }),
    ev(5, {
      type: 'tool_use_completed',
      tool_use_id: 'bg-tool-2',
      raw_name: 'Task',
      result_summary: 'background done',
      success: true,
    }),
    ev(6, {
      type: 'tool_use_started',
      tool_use_id: 'fg-tool-1',
      raw_name: 'Read',
      input_summary: 'src/main.ts',
      needs_response: false,
      category: { category: 'file_op', raw_name: 'Read' },
    }),
    ev(7, {
      type: 'tool_use_completed',
      tool_use_id: 'fg-tool-1',
      raw_name: 'Read',
      result_content: 'file body',
      result_summary: 'file body',
      success: true,
    }),
  ];

  const oneShot = mod.buildMessagesFromEvents(baseMessages(), [], events, null);
  assert.ok(!oneShot.some((message) => message.content === 'background boom'),
    'failed background completion must not render an error row');
  assert.ok(!oneShot.some((message) =>
    Array.isArray(message.content)
    && message.content.some((block) => block.type === 'tool_result' && block.tool_use_id === 'bg-tool-2')),
    'successful background completion must not render a result row');

  // Incremental: fold the background registration first, then append the
  // completions — the accumulator must survive exactly like one-shot.
  const state = mod.deriveTranscriptReset(baseMessages(), [], events.slice(0, 3), null);
  const incremental = mod.finalizeTranscriptMessages(
    mod.deriveTranscriptAppend(state, events.slice(3)),
  );
  assert.deepEqual(incremental, oneShot);

  // Registration arriving IN the appended batch works too (streaming case).
  const lateState = mod.deriveTranscriptReset(baseMessages(), [], events.slice(0, 1), null);
  const lateIncremental = mod.finalizeTranscriptMessages(
    mod.deriveTranscriptAppend(lateState, events.slice(1)),
  );
  assert.deepEqual(lateIncremental, oneShot);
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

test('head rebase consumes events that confirm the optimistic prompt in the same render', async () => {
  const mod = await importTranscriptModule();
  const seed = [];
  const initialPrompt = {
    id: 'initial-user',
    text: 'first prompt',
    timestamp: BASE_TS,
  };
  const initialReplay = {
    initialPrompt,
    remainingPrompts: [],
  };
  const initialState = mod.deriveTranscriptReset(
    mod.buildBaseMessages(seed, initialReplay.initialPrompt),
    initialReplay.remainingPrompts,
    [],
    null,
    { seedMessages: seed, prompts: initialReplay },
  );
  const completedEvents = [
    ev(1, { type: 'user_prompt', text: 'first prompt' }),
    ev(2, { type: 'assistant_chunk', text: 'CCEM_FIRST_OK' }),
    ev(3, {
      type: 'lifecycle',
      stage: 'turn_completed',
      assistant_message_uuid: 'assistant-first',
    }),
  ];
  const confirmedReplay = {
    initialPrompt: undefined,
    remainingPrompts: [],
  };

  const rebased = mod.rebaseTranscriptHead(
    initialState,
    mod.buildBaseMessages(seed, confirmedReplay.initialPrompt),
    completedEvents,
    confirmedReplay.remainingPrompts,
    { seedMessages: seed, prompts: confirmedReplay },
  );
  const messages = mod.finalizeTranscriptMessages(rebased);

  assert.equal(rebased.consumedSeq, 3);
  assert.deepEqual(
    messages.map((message) => ({
      msgType: message.msgType,
      content: message.content,
    })),
    [
      { msgType: 'user', content: 'first prompt' },
      { msgType: 'assistant', content: 'CCEM_FIRST_OK' },
    ],
  );
});

test('queued prompt stays outside the transcript until persisted admission then appears once', async () => {
  const mod = await importTranscriptModule();
  const queuedPrompt = {
    id: 'client-message-queued-1',
    text: 'follow up once',
    timestamp: BASE_TS + 1_500,
    afterEventSeq: 1,
    deferUntilPersisted: true,
    queuedBehindTurn: true,
    queuedDeliveryState: 'pending',
  };
  const seed = [];
  const initialEvents = [
    ev(1, { type: 'assistant_chunk', text: 'active answer part one. ' }),
  ];
  let replayToken = { revision: 1 };
  let state = mod.deriveTranscriptReset(
    seed,
    [],
    initialEvents,
    null,
    { tokens: { seedMessages: seed, prompts: replayToken } },
  );

  const assertQueuedPromptAbsent = () => {
    const messages = mod.finalizeTranscriptMessages(state);
    assert.equal(
      messages.filter((message) => message.uuid === queuedPrompt.id).length,
      0,
      'backend-owned queued prompts belong to the composer queue, not the transcript',
    );
  };

  assertQueuedPromptAbsent();

  const streamingEvents = [
    ...initialEvents,
    ev(2, { type: 'system_message', message: 'still working' }),
    ev(3, { type: 'assistant_chunk', text: 'part two.' }),
  ];
  for (let end = 2; end <= streamingEvents.length; end += 1) {
    replayToken = { revision: end };
    state = mod.rebaseTranscriptHead(
      state,
      seed,
      streamingEvents.slice(0, end),
      [],
      { seedMessages: seed, prompts: replayToken },
    );
    assertQueuedPromptAbsent();
  }

  const confirmedEvents = [
    ...streamingEvents,
    ev(4, {
      type: 'user_prompt',
      text: queuedPrompt.text,
      image_count: 0,
      client_message_id: queuedPrompt.id,
    }),
  ];
  state = mod.rebaseTranscriptHead(
    state,
    seed,
    confirmedEvents,
    [],
    { seedMessages: seed, prompts: { revision: 4 } },
  );
  const confirmedMessages = mod.finalizeTranscriptMessages(state);

  assert.deepEqual(
    confirmedMessages.map((message) => message.msgType),
    ['assistant', 'user'],
  );
  assert.equal(
    confirmedMessages.filter((message) => message.content === queuedPrompt.text).length,
    1,
    'persisted confirmation must replace the optimistic row, not add another row',
  );
  assert.equal(confirmedMessages[1].uuid, 'user-prompt-4');
});

test('same-text queued prompts converge independently by client message id', async () => {
  const mod = await importTranscriptModule();
  const seed = [];
  const first = {
    id: 'client-repeat-first',
    text: 'repeat this',
    afterEventSeq: 1,
    deferUntilPersisted: true,
  };
  const second = {
    id: 'client-repeat-second',
    text: 'repeat this',
    afterEventSeq: 1,
    deferUntilPersisted: true,
  };
  const activeEvents = [
    ev(1, { type: 'assistant_chunk', text: 'active answer' }),
    ev(2, { type: 'assistant_chunk', text: ' continues' }),
  ];
  let state = mod.deriveTranscriptReset(
    seed,
    [first, second],
    activeEvents,
    null,
    { tokens: { seedMessages: seed, prompts: { revision: 1 } } },
  );

  for (const prompt of [first, second]) {
    assert.equal(
      mod.finalizeTranscriptMessages(state).filter((message) => message.uuid === prompt.id).length,
      1,
    );
  }

  const firstConfirmedEvents = [
    ...activeEvents,
    ev(3, {
      type: 'user_prompt',
      text: first.text,
      image_count: 0,
      client_message_id: first.id,
    }),
  ];
  state = mod.rebaseTranscriptHead(
    state,
    seed,
    firstConfirmedEvents,
    [second],
    { seedMessages: seed, prompts: { revision: 2 } },
  );
  let messages = mod.finalizeTranscriptMessages(state);
  assert.deepEqual(
    messages.filter((message) => message.msgType === 'user').map((message) => message.uuid),
    ['user-prompt-3', second.id],
  );

  const bothConfirmedEvents = [
    ...firstConfirmedEvents,
    ev(4, {
      type: 'user_prompt',
      text: second.text,
      image_count: 0,
      client_message_id: second.id,
    }),
  ];
  state = mod.rebaseTranscriptHead(
    state,
    seed,
    bothConfirmedEvents,
    [],
    { seedMessages: seed, prompts: { revision: 3 } },
  );
  messages = mod.finalizeTranscriptMessages(state);
  assert.deepEqual(
    messages.filter((message) => message.msgType === 'user').map((message) => message.uuid),
    ['user-prompt-3', 'user-prompt-4'],
  );
});

test('image-only queued prompt converges by client message id across storage representations', async () => {
  const mod = await importTranscriptModule();
  const seed = [];
  const queuedPrompt = {
    id: 'client-image-only',
    text: '[Image #1]',
    images: [{
      mediaType: 'image/png',
      base64Data: 'aW1hZ2UtYnl0ZXM=',
      placeholder: '[Image #1]',
    }],
    afterEventSeq: 1,
    deferUntilPersisted: true,
  };
  const activeEvents = [
    ev(1, { type: 'assistant_chunk', text: 'finishing the active turn' }),
  ];
  let state = mod.deriveTranscriptReset(
    seed,
    [queuedPrompt],
    activeEvents,
    null,
    { tokens: { seedMessages: seed, prompts: { revision: 1 } } },
  );

  assert.equal(
    mod.finalizeTranscriptMessages(state).filter((message) => message.uuid === queuedPrompt.id).length,
    1,
  );

  const confirmedEvents = [
    ...activeEvents,
    ev(2, {
      type: 'user_prompt',
      text: queuedPrompt.text,
      image_count: 1,
      client_message_id: queuedPrompt.id,
      images: [{
        mediaType: 'image/png',
        storagePath: '/persisted/image.png',
        sha256: 'persisted-image-hash',
        placeholder: '[Image #1]',
      }],
    }),
  ];
  const pendingPrompts = mod.filterConfirmedLocalUserPrompts(
    [queuedPrompt],
    confirmedEvents,
  );
  state = mod.rebaseTranscriptHead(
    state,
    seed,
    confirmedEvents,
    pendingPrompts,
    { seedMessages: seed, prompts: { revision: 2 } },
  );
  const messages = mod.finalizeTranscriptMessages(state);
  const userMessages = messages.filter((message) => message.msgType === 'user');

  assert.deepEqual(pendingPrompts, []);
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0].uuid, 'user-prompt-2');
  assert.deepEqual(userMessages[0].content, [{
    type: 'image',
    mediaType: 'image/png',
    placeholder: '[Image #1]',
    storagePath: '/persisted/image.png',
    sha256: 'persisted-image-hash',
  }]);
});

test('deferred interactive reply survives mixed confirmed history rebase without duplication', async () => {
  const mod = await importTranscriptModule();
  const seed = [];
  const confirmedPrompt = {
    id: 'client-confirmed-history',
    text: 'earlier request',
    afterEventSeq: 0,
  };
  const interactivePrompt = {
    id: 'interactive-plan-reply',
    text: 'approve this plan',
    afterEventSeq: 2,
    deferUntilPersisted: true,
  };
  const retainedLocalPrompts = [confirmedPrompt, interactivePrompt];
  const initialEvents = [
    ev(1, {
      type: 'user_prompt',
      text: confirmedPrompt.text,
      image_count: 0,
      client_message_id: confirmedPrompt.id,
    }),
    ev(2, { type: 'assistant_chunk', text: 'active answer part one. ' }),
  ];
  let pendingPrompts = mod.filterConfirmedLocalUserPrompts(
    retainedLocalPrompts,
    initialEvents,
  );
  let replay = mod.splitLocalUserPromptsForReplay(pendingPrompts);
  let state = mod.deriveTranscriptReset(
    seed,
    replay.remainingPrompts,
    initialEvents,
    null,
    { tokens: { seedMessages: seed, prompts: replay } },
  );

  const assertSingleInteractiveProjection = () => {
    const messages = mod.finalizeTranscriptMessages(state);
    assert.equal(
      messages.filter((message) => message.uuid === interactivePrompt.id).length,
      1,
      'the interactive reply must remain one optimistic row',
    );
    assert.equal(
      messages.filter((message) => message.msgType === 'assistant').length,
      1,
      'rebase must not split the active assistant turn around the reply',
    );
  };

  assert.deepEqual(pendingPrompts.map((prompt) => prompt.id), [interactivePrompt.id]);
  assertSingleInteractiveProjection();

  const streamingEvents = [
    ...initialEvents,
    ev(3, { type: 'system_message', message: 'still working' }),
    ev(4, { type: 'assistant_chunk', text: 'part two.' }),
  ];
  for (let end = initialEvents.length + 1; end <= streamingEvents.length; end += 1) {
    const visibleEvents = streamingEvents.slice(0, end);
    const nextPendingPrompts = mod.filterConfirmedLocalUserPrompts(
      retainedLocalPrompts,
      visibleEvents,
    );
    assert.notEqual(
      nextPendingPrompts,
      pendingPrompts,
      'retained confirmed history recreates the replay input on each event update',
    );
    pendingPrompts = nextPendingPrompts;
    replay = mod.splitLocalUserPromptsForReplay(pendingPrompts);
    state = mod.rebaseTranscriptHead(
      state,
      seed,
      visibleEvents,
      replay.remainingPrompts,
      { seedMessages: seed, prompts: replay },
    );
    assertSingleInteractiveProjection();
  }

  const confirmedEvents = [
    ...streamingEvents,
    ev(5, {
      type: 'user_prompt',
      text: interactivePrompt.text,
      image_count: 0,
    }),
  ];
  pendingPrompts = mod.filterConfirmedLocalUserPrompts(
    retainedLocalPrompts,
    confirmedEvents,
  );
  replay = mod.splitLocalUserPromptsForReplay(pendingPrompts);
  state = mod.rebaseTranscriptHead(
    state,
    seed,
    confirmedEvents,
    replay.remainingPrompts,
    { seedMessages: seed, prompts: replay },
  );
  const messages = mod.finalizeTranscriptMessages(state);

  assert.deepEqual(pendingPrompts, []);
  assert.equal(
    messages.filter((message) => message.content === interactivePrompt.text).length,
    1,
    'the persisted interactive reply must replace its optimistic row',
  );
  assert.equal(
    messages.filter((message) => message.msgType === 'assistant').length,
    1,
    'the completed active turn must remain one assistant message',
  );
});

test('head rebase resets when replay backfills events below the consumed marker', async () => {
  const mod = await importTranscriptModule();
  const completeEvents = buildFixture(50);
  const cachedTail = completeEvents.slice(10);
  const seed = baseMessages();
  const initialTokens = { seedMessages: seed, prompts: { revision: 1 } };
  const cachedState = mod.deriveTranscriptReset(
    mod.buildBaseMessages(seed, undefined),
    [],
    cachedTail,
    null,
    { tokens: initialTokens },
  );

  const rebased = mod.rebaseTranscriptHead(
    cachedState,
    mod.buildBaseMessages(seed, undefined),
    completeEvents,
    [],
    { seedMessages: seed, prompts: { revision: 2 } },
  );

  assert.equal(rebased.consumedCount, completeEvents.length);
  assert.deepEqual(
    mod.finalizeTranscriptMessages(rebased),
    mod.buildMessagesFromEvents(seed, [], completeEvents, null),
  );
});
