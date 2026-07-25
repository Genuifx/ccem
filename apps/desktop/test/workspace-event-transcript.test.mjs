import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWorkspaceEventTranscript() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-event-test-'));
  const outputPath = path.join(tempDir, 'workspaceEventTranscript.mjs');
  await build({
    entryPoints: [path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceEventTranscript.ts')],
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outputPath).href);
}

function event(seq, payload) {
  return eventAt(seq, payload, `2026-05-01T00:00:${String(seq).padStart(2, '0')}.000Z`);
}

function eventAt(seq, payload, occurredAt) {
  return {
    runtime_id: 'runtime-1',
    seq,
    occurred_at: occurredAt,
    payload,
  };
}

test('live transcript preserves thinking, tool, and text event order in assistant content', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [{ msgType: 'user', uuid: 'user-1', content: '开始', segmentIndex: 0, isCompactBoundary: false }],
    [],
    [
      event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
      event(2, { type: 'assistant_chunk', text: '先说一句。' }),
      event(3, { type: 'tool_use_started', tool_use_id: 'tool-1', raw_name: 'Read', input_summary: 'src/a.ts', needs_response: false, category: { category: 'file_op', raw_name: 'Read' } }),
      event(4, { type: 'tool_use_completed', tool_use_id: 'tool-1', raw_name: 'Read', result_summary: 'ok', success: true }),
      event(5, { type: 'system_message', message: '再思考一下' }),
      event(6, { type: 'assistant_chunk', text: '最后回答。' }),
      event(7, { type: 'lifecycle', stage: 'turn_completed', detail: '' }),
    ],
  );

  assert.deepEqual(messages[1].content, [
    { type: 'text', text: '先说一句。' },
    {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
      input: { summary: 'src/a.ts' },
      _startedAt: Date.parse('2026-05-01T00:00:03.000Z'),
      _result: 'ok',
      _resultError: false,
      _completedAt: Date.parse('2026-05-01T00:00:04.000Z'),
    },
    {
      type: 'thinking',
      thinking: '再思考一下',
      _startedAt: Date.parse('2026-05-01T00:00:05.000Z'),
      _completedAt: Date.parse('2026-05-01T00:00:05.000Z'),
    },
    { type: 'text', text: '最后回答。' },
  ]);
});

test('live transcript attaches full subagent result content when available', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();
  const fullResult = '# Review\n\n- finding one\n- finding two\n\n```ts\nconst ok = true;\n```';

  const messages = buildMessagesFromEvents(
    [{ msgType: 'user', uuid: 'user-1', content: '审一下', segmentIndex: 0, isCompactBoundary: false }],
    [],
    [
      event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
      event(2, { type: 'tool_use_started', tool_use_id: 'tool-agent', raw_name: 'Agent', input_summary: 'review drawer', needs_response: false, category: { category: 'task_mgmt', raw_name: 'Agent' } }),
      event(3, {
        type: 'tool_use_completed',
        tool_use_id: 'tool-agent',
        raw_name: 'Agent',
        result_summary: '# Review...',
        result_content: fullResult,
        success: true,
      }),
      event(4, { type: 'lifecycle', stage: 'turn_completed', detail: '' }),
    ],
  );

  assert.deepEqual(messages[1].content, [
    {
      type: 'tool_use',
      id: 'tool-agent',
      name: 'Agent',
      input: { summary: 'review drawer' },
      _startedAt: Date.parse('2026-05-01T00:00:02.000Z'),
      _result: fullResult,
      _resultError: false,
      _completedAt: Date.parse('2026-05-01T00:00:03.000Z'),
    },
  ]);
});

test('live transcript appends streaming thinking deltas without inserting paragraph breaks', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [{ msgType: 'user', uuid: 'user-1', content: 'hello', segmentIndex: 0, isCompactBoundary: false }],
    [],
    [
      event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
      event(2, { type: 'system_message', message: 'The' }),
      event(3, { type: 'system_message', message: ' user' }),
      event(4, { type: 'system_message', message: ' is' }),
      event(5, { type: 'system_message', message: ' greeting' }),
      event(6, { type: 'lifecycle', stage: 'turn_completed', detail: '' }),
    ],
  );

  assert.deepEqual(messages[1].content, [
    {
      type: 'thinking',
      thinking: 'The user is greeting',
      _startedAt: Date.parse('2026-05-01T00:00:02.000Z'),
      _completedAt: Date.parse('2026-05-01T00:00:05.000Z'),
    },
  ]);
});

test('live transcript renders context compaction progress and replaces it with a boundary', async () => {
  const {
    buildMessagesFromEvents,
    COMPACTING_SUMMARY_TOKEN,
  } = await importWorkspaceEventTranscript();

  const base = [
    { msgType: 'user', uuid: 'user-1', content: 'long task', segmentIndex: 0, isCompactBoundary: false },
  ];
  const compacting = buildMessagesFromEvents(base, [], [
    event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
    event(2, { type: 'assistant_chunk', text: 'Working before compact.' }),
    event(3, { type: 'lifecycle', stage: 'compacting', detail: 'Claude is compacting the context.' }),
  ]);

  assert.equal(compacting[1].msgType, 'assistant');
  assert.equal(compacting[2].msgType, 'summary');
  assert.equal(compacting[2].summary, COMPACTING_SUMMARY_TOKEN);

  const completed = buildMessagesFromEvents(base, [], [
    event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
    event(2, { type: 'assistant_chunk', text: 'Working before compact.' }),
    event(3, { type: 'lifecycle', stage: 'compacting', detail: 'Claude is compacting the context.' }),
    event(4, { type: 'lifecycle', stage: 'compact_completed', detail: 'Claude compacted the context.' }),
  ]);

  assert.equal(completed[2].msgType, 'compact_boundary');
  assert.equal(completed[2].isCompactBoundary, true);
  assert.equal(completed.some((message) => message.summary === COMPACTING_SUMMARY_TOKEN), false);
});

test('live transcript records process timing metadata for duration display', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [{ msgType: 'user', uuid: 'user-1', content: 'run', segmentIndex: 0, isCompactBoundary: false }],
    [],
    [
      event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
      event(2, { type: 'system_message', message: 'Thinking' }),
      event(3, { type: 'tool_use_started', tool_use_id: 'tool-1', raw_name: 'Bash', input_summary: 'pnpm test', needs_response: false, category: { category: 'shell', raw_name: 'Bash' } }),
      event(5, { type: 'tool_use_completed', tool_use_id: 'tool-1', raw_name: 'Bash', result_summary: 'ok', success: true }),
      event(6, { type: 'lifecycle', stage: 'turn_completed', detail: '' }),
    ],
  );

  const [thinkingBlock, toolBlock] = messages[1].content;
  assert.equal(thinkingBlock._startedAt, Date.parse('2026-05-01T00:00:02.000Z'));
  assert.equal(thinkingBlock._completedAt, Date.parse('2026-05-01T00:00:02.000Z'));
  assert.equal(toolBlock._startedAt, Date.parse('2026-05-01T00:00:03.000Z'));
  assert.equal(toolBlock._completedAt, Date.parse('2026-05-01T00:00:05.000Z'));
});

test('live transcript attaches token usage to the completed assistant turn', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [{ msgType: 'user', uuid: 'user-1', content: 'run', segmentIndex: 0, isCompactBoundary: false }],
    [],
    [
      event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
      event(2, { type: 'assistant_chunk', text: 'Done.' }),
      event(3, { type: 'lifecycle', stage: 'turn_completed', detail: '' }),
      event(4, {
        type: 'token_usage',
        provider: 'codex',
        input_tokens: 100,
        output_tokens: 348,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      }),
    ],
  );

  assert.equal(messages[1].msgType, 'assistant');
  assert.equal(messages[1].inputTokens, 100);
  assert.equal(messages[1].outputTokens, 348);
});

test('renders unmatched failed tool results as visible assistant errors', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [],
    [],
    [
      event(1, { type: 'user_prompt', text: '用不存在的 Skill: CC', image_count: 0 }),
      event(2, {
        type: 'tool_use_completed',
        tool_use_id: 'missing-skill',
        raw_name: 'Skill',
        result_summary: 'Skill not found: CC',
        success: false,
      }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => [message.msgType, message.content]),
    [
      ['user', '用不存在的 Skill: CC'],
      ['assistant', 'Skill not found: CC'],
    ],
  );
});

test('renders completed turns with only lifecycle detail as visible feedback', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [],
    [],
    [
      event(1, { type: 'user_prompt', text: '/lightweight-dev-mode 继续', image_count: 0 }),
      event(2, { type: 'lifecycle', stage: 'runtime_resume', detail: 'Reconnected native runtime helper.' }),
      event(3, { type: 'lifecycle', stage: 'processing', detail: 'Claude is processing a turn.' }),
      event(4, {
        type: 'token_usage',
        provider: 'claude',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        scope: 'turn_total',
      }),
      event(5, { type: 'lifecycle', stage: 'turn_completed', detail: 'Unknown skill: lightweight-dev-mode' }),
      event(6, { type: 'lifecycle', stage: 'ready', detail: 'Ready for the next prompt.' }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => [message.msgType, message.content]),
    [
      ['user', '/lightweight-dev-mode 继续'],
      ['assistant', 'Unknown skill: lightweight-dev-mode'],
    ],
  );
});

test('keeps native runtime diagnostics out of visible chat turns', async () => {
  const {
    buildMessagesFromEvents,
    shouldTreatNativeSessionAsProcessing,
  } = await importWorkspaceEventTranscript();

  const diagnosticEvents = [
    event(1, { type: 'user_prompt', text: 'continue', image_count: 0 }),
    event(2, { type: 'lifecycle', stage: 'prompt_send_requested', detail: 'chars=8 images=0' }),
    event(3, { type: 'lifecycle', stage: 'prompt_send_written', detail: 'helper accepted prompt command' }),
    event(4, { type: 'lifecycle', stage: 'stop_requested', detail: 'Desktop workspace requested native runtime stop.' }),
    event(5, { type: 'lifecycle', stage: 'stop_written', detail: 'Native helper accepted stop command.' }),
    event(6, { type: 'lifecycle', stage: 'interrupt_requested', detail: 'Claude interrupt requested by desktop workspace.' }),
    event(7, { type: 'lifecycle', stage: 'interrupt_timeout', detail: 'Claude interrupt timed out after 40ms' }),
    event(8, { type: 'lifecycle', stage: 'stop_force_killed', detail: 'Removed stale helper handle.' }),
    event(9, { type: 'lifecycle', stage: 'handoff_requested', detail: 'Terminal handoff requested.' }),
    event(10, { type: 'lifecycle', stage: 'handoff_failed', detail: 'Terminal handoff failed.' }),
    event(11, { type: 'lifecycle', stage: 'idle_stop', detail: 'Idle helper stopped after completion.' }),
    event(12, { type: 'lifecycle', stage: 'closed_idle', detail: 'Claude runtime stopped after completed turn.' }),
  ];

  const messages = buildMessagesFromEvents([], [], diagnosticEvents);

  assert.deepEqual(
    messages.map((message) => [message.msgType, message.content]),
    [['user', 'continue']],
  );
  assert.equal(
    shouldTreatNativeSessionAsProcessing('processing', diagnosticEvents),
    false,
  );
});

test('live transcript renders user prompt images from native events', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [],
    [],
    [
      event(1, {
        type: 'user_prompt',
        text: '看一下这个时间\n\nImages attached: 1',
        image_count: 1,
        images: [{
          mediaType: 'image/png',
          base64Data: 'iVBORw0KGgo=',
          placeholder: '[Image #1]',
        }],
      }),
    ],
  );

  assert.deepEqual(messages, [{
    msgType: 'user',
    uuid: 'user-prompt-1',
    content: [
      { type: 'text', text: '看一下这个时间' },
      {
        type: 'image',
        mediaType: 'image/png',
        base64Data: 'iVBORw0KGgo=',
        placeholder: '[Image #1]',
      },
    ],
    timestamp: Date.parse('2026-05-01T00:00:01.000Z'),
    segmentIndex: 0,
    isCompactBoundary: false,
  }]);
});

test('live transcript renders stored user prompt image refs from native events', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [],
    [],
    [
      event(1, {
        type: 'user_prompt',
        text: '看一下这个时间\n\nImages attached: 1',
        image_count: 1,
        images: [{
          mediaType: 'image/png',
          storagePath: 'abc123.png',
          sha256: 'abc123',
          byteSize: 8,
          placeholder: '[Image #1]',
        }],
      }),
    ],
  );

  assert.deepEqual(messages[0].content, [
    { type: 'text', text: '看一下这个时间' },
    {
      type: 'image',
      mediaType: 'image/png',
      storagePath: 'abc123.png',
      sha256: 'abc123',
      byteSize: 8,
      placeholder: '[Image #1]',
    },
  ]);
});

test('legacy image-only native events keep an attachment count fallback', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [],
    [],
    [event(1, { type: 'user_prompt', text: '', image_count: 2 })],
  );

  assert.equal(messages[0].content, 'Images attached: 2');
});

test('session summary refresh treats runtime error events as boundary events', async () => {
  const { sessionEventsNeedSummaryRefresh } = await importWorkspaceEventTranscript();

  assert.equal(sessionEventsNeedSummaryRefresh([
    event(1, { type: 'assistant_chunk', text: 'still streaming' }),
  ]), false);
  assert.equal(sessionEventsNeedSummaryRefresh([
    event(2, { type: 'stderr_line', line: 'Skill not found: CC' }),
  ]), true);
  assert.equal(sessionEventsNeedSummaryRefresh([
    event(3, { type: 'lifecycle', stage: 'error', detail: 'Native runtime failed' }),
  ]), true);
  assert.equal(sessionEventsNeedSummaryRefresh([
    event(4, { type: 'lifecycle', stage: 'turn_interrupted', detail: 'Turn interrupted.' }),
  ]), true);
  assert.equal(sessionEventsNeedSummaryRefresh([
    event(5, {
      type: 'tool_use_completed',
      tool_use_id: 'missing-skill',
      raw_name: 'Skill',
      result_summary: 'Skill not found: CC',
      success: false,
    }),
  ]), true);
});

test('native processing state falls back to event boundaries when the summary is stale', async () => {
  const { shouldTreatNativeSessionAsProcessing } = await importWorkspaceEventTranscript();

  assert.equal(shouldTreatNativeSessionAsProcessing('processing', [
    event(1, { type: 'user_prompt', text: 'continue', image_count: 0 }),
    event(2, { type: 'lifecycle', stage: 'processing', detail: 'Claude is processing a turn.' }),
    event(3, { type: 'assistant_chunk', text: 'done' }),
    event(4, { type: 'lifecycle', stage: 'turn_completed', detail: 'Claude turn completed.' }),
    event(5, { type: 'lifecycle', stage: 'ready', detail: 'Ready for the next prompt.' }),
  ]), false);

  assert.equal(shouldTreatNativeSessionAsProcessing('processing', [
    event(1, { type: 'user_prompt', text: 'continue', image_count: 0 }),
    event(2, { type: 'lifecycle', stage: 'turn_started', detail: 'Claude is processing a turn.' }),
    event(3, { type: 'system_message', message: 'thinking' }),
  ], Date.parse('2026-05-01T00:00:04.000Z')), true);

  assert.equal(shouldTreatNativeSessionAsProcessing('processing', [
    event(1, { type: 'lifecycle', stage: 'turn_started', detail: 'Claude is processing a turn.' }),
  ], Date.parse('2026-05-01T00:11:02.000Z')), false);

  assert.equal(shouldTreatNativeSessionAsProcessing('processing', [
    event(1, { type: 'lifecycle', stage: 'turn_started', detail: 'Claude is processing a turn.' }),
  ], Date.parse('2026-05-01T00:02:00.000Z')), true);

  assert.equal(shouldTreatNativeSessionAsProcessing('processing', []), true);
  assert.equal(shouldTreatNativeSessionAsProcessing('ready', [
    event(1, { type: 'lifecycle', stage: 'turn_started', detail: 'Claude is processing a turn.' }),
  ]), false);
});

test('dedupes live events linearly while preserving first-seen order', async () => {
  const { dedupeEvents } = await importWorkspaceEventTranscript();

  const events = [
    event(1, { type: 'assistant_chunk', text: 'a' }),
    event(2, { type: 'assistant_chunk', text: 'b' }),
    event(1, { type: 'assistant_chunk', text: 'duplicate' }),
    { ...event(1, { type: 'assistant_chunk', text: 'other runtime' }), runtime_id: 'runtime-2' },
  ];

  assert.deepEqual(
    dedupeEvents(events).map((item) => `${item.runtime_id}:${item.seq}:${item.payload.text}`),
    ['runtime-1:1:a', 'runtime-1:2:b', 'runtime-2:1:other runtime'],
  );
});

test('appends monotonic live events without reallocating on duplicate-only batches', async () => {
  const { appendSessionEvents } = await importWorkspaceEventTranscript();

  const previous = [
    event(1, { type: 'assistant_chunk', text: 'a' }),
    event(2, { type: 'assistant_chunk', text: 'b' }),
  ];
  const appended = appendSessionEvents(previous, [
    event(3, { type: 'assistant_chunk', text: 'c' }),
  ]);
  assert.deepEqual(appended.map((item) => item.seq), [1, 2, 3]);

  const dedupedIncoming = appendSessionEvents(previous, [
    event(3, { type: 'assistant_chunk', text: 'c' }),
    event(3, { type: 'assistant_chunk', text: 'duplicate' }),
  ]);
  assert.deepEqual(dedupedIncoming.map((item) => `${item.seq}:${item.payload.text}`), [
    '1:a',
    '2:b',
    '3:c',
  ]);

  const unchanged = appendSessionEvents(appended, [
    event(2, { type: 'assistant_chunk', text: 'duplicate' }),
  ]);
  assert.equal(unchanged, appended);

  const reset = appendSessionEvents(appended, [
    event(10, { type: 'assistant_chunk', text: 'reset' }),
  ], true);
  assert.deepEqual(reset.map((item) => item.seq), [10]);
});

test('live transcript marks retained-anchor sequence gaps as unloaded transcript', async () => {
  const {
    buildMessagesFromEvents,
    TRANSCRIPT_GAP_SUMMARY_TOKEN,
  } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [],
    [],
    [
      event(1, { type: 'lifecycle', stage: 'runtime_boot', detail: 'Starting claude native runtime.' }),
      event(2, { type: 'user_prompt', text: 'initial prompt', image_count: 0 }),
      event(474, { type: 'user_prompt', text: '对，就是启用环境（推荐）', image_count: 0 }),
      event(1853, { type: 'assistant_chunk', text: 'tail content' }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => [message.msgType, message.summary ?? message.content]),
    [
      ['user', 'initial prompt'],
      ['summary', TRANSCRIPT_GAP_SUMMARY_TOKEN],
      ['user', '对，就是启用环境（推荐）'],
      ['summary', TRANSCRIPT_GAP_SUMMARY_TOKEN],
      ['assistant', 'tail content'],
    ],
  );
});

test('turn_interrupted flushes the active assistant turn before later prompts', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [],
    [],
    [
      event(1, { type: 'user_prompt', text: 'first prompt', image_count: 0 }),
      event(2, { type: 'assistant_chunk', text: 'partial reply' }),
      event(3, { type: 'lifecycle', stage: 'turn_interrupted', detail: 'Turn interrupted.' }),
      event(4, { type: 'user_prompt', text: 'second prompt', image_count: 0 }),
      event(5, { type: 'assistant_chunk', text: 'second reply' }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => [message.msgType, message.content]),
    [
      ['user', 'first prompt'],
      ['assistant', 'partial reply'],
      ['user', 'second prompt'],
      ['assistant', 'second reply'],
    ],
  );
});

test('keeps partial Claude text visible beside one incomplete-response error before the recovered turn', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();
  const incompleteReason = 'Claude response ended before a final result. Partial output was preserved; send the next prompt to retry.';

  const messages = buildMessagesFromEvents(
    [],
    [],
    [
      event(1, { type: 'user_prompt', text: 'first prompt', image_count: 0 }),
      event(2, { type: 'assistant_chunk', text: 'partial reply' }),
      event(3, { type: 'session_completed', reason: incompleteReason }),
      event(4, { type: 'user_prompt', text: 'second prompt', image_count: 0 }),
      event(5, { type: 'assistant_chunk', text: 'recovered reply' }),
      event(6, { type: 'lifecycle', stage: 'turn_completed', detail: 'done' }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => [message.msgType, message.content]),
    [
      ['user', 'first prompt'],
      ['assistant', 'partial reply'],
      ['assistant', incompleteReason],
      ['user', 'second prompt'],
      ['assistant', 'recovered reply'],
    ],
  );
});

test('renders persisted native user prompts as turn boundaries without lifecycle markers', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [],
    [],
    [
      event(1, { type: 'user_prompt', text: 'first prompt', image_count: 0 }),
      event(2, { type: 'assistant_chunk', text: 'first reply' }),
      event(3, { type: 'user_prompt', text: 'second prompt', image_count: 0 }),
      event(4, { type: 'assistant_chunk', text: 'second reply' }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => [message.msgType, message.content]),
    [
      ['user', 'first prompt'],
      ['assistant', 'first reply'],
      ['user', 'second prompt'],
      ['assistant', 'second reply'],
    ],
  );
});

test('anchors optimistic interactive replies before later assistant events', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [],
    [
      {
        id: 'ask-reply',
        text: '改 Moonshot 用品牌色 + 去掉 needsContrastBg',
        afterEventSeq: 3,
      },
    ],
    [
      event(1, { type: 'assistant_chunk', text: 'Before asking. ' }),
      event(2, { type: 'lifecycle', stage: 'turn_completed', detail: '' }),
      event(3, { type: 'tool_use_started', tool_use_id: 'tool-1', raw_name: 'AskUserQuestion', input_summary: 'question', needs_response: true, category: { category: 'user_input', kind: 'question', raw_name: 'AskUserQuestion' } }),
      event(4, { type: 'system_message', message: 'Now continuing after the answer.' }),
      event(5, { type: 'assistant_chunk', text: 'Done.' }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => [message.msgType, message.content]),
    [
      ['assistant', 'Before asking. '],
      ['user', '改 Moonshot 用品牌色 + 去掉 needsContrastBg'],
      ['assistant', [
        {
          type: 'thinking',
          thinking: 'Now continuing after the answer.',
          _startedAt: Date.parse('2026-05-01T00:00:04.000Z'),
          _completedAt: Date.parse('2026-05-01T00:00:04.000Z'),
        },
        { type: 'text', text: 'Done.' },
      ]],
    ],
  );
});

test('filters optimistic native prompts already confirmed by the event log', async () => {
  const { filterConfirmedLocalUserPrompts } = await importWorkspaceEventTranscript();

  const pending = filterConfirmedLocalUserPrompts(
    [
      { id: 'first', text: 'repeat me' },
      { id: 'second', text: 'repeat me' },
      { id: 'third', text: 'still local' },
    ],
    [
      event(1, { type: 'user_prompt', text: 'repeat me', image_count: 0 }),
    ],
  );

  assert.deepEqual(
    pending.map((prompt) => prompt.id),
    ['second', 'third'],
  );
});

test('keeps optimistic prompts when matching persisted events predate their anchor', async () => {
  const { filterConfirmedLocalUserPrompts } = await importWorkspaceEventTranscript();

  const pending = filterConfirmedLocalUserPrompts(
    [
      { id: 'new-repeat', text: '继续', afterEventSeq: 10 },
    ],
    [
      event(2, { type: 'user_prompt', text: '继续', image_count: 0 }),
    ],
  );

  assert.deepEqual(
    pending.map((prompt) => prompt.id),
    ['new-repeat'],
  );
});

test('does not consume anchored optimistic prompts with older persisted user events', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();

  const messages = buildMessagesFromEvents(
    [],
    [
      { id: 'new-repeat', text: '继续', afterEventSeq: 10 },
    ],
    [
      event(2, { type: 'user_prompt', text: '继续', image_count: 0 }),
      event(3, { type: 'assistant_chunk', text: 'old answer' }),
      event(4, { type: 'lifecycle', stage: 'turn_completed', detail: '' }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => message.uuid),
    ['user-prompt-2', 'assistant-turn-3', 'new-repeat'],
  );
});

test('keeps optimistic prompts when only whitespace-stripped identity matches', async () => {
  const { filterConfirmedLocalUserPrompts } = await importWorkspaceEventTranscript();

  const pending = filterConfirmedLocalUserPrompts(
    [
      { id: 'space-sensitive', text: 'ab' },
    ],
    [
      event(1, { type: 'user_prompt', text: 'a b', image_count: 0 }),
    ],
  );

  assert.deepEqual(
    pending.map((prompt) => prompt.id),
    ['space-sensitive'],
  );
});

test('keeps optimistic continuation prompts after persisted transcript events', async () => {
  const {
    buildBaseMessages,
    buildMessagesFromEvents,
    splitLocalUserPromptsForReplay,
  } = await importWorkspaceEventTranscript();
  const split = splitLocalUserPromptsForReplay([
    { id: 'new-message', text: 'second prompt' },
  ]);

  const messages = buildMessagesFromEvents(
    buildBaseMessages([], split.initialPrompt),
    split.remainingPrompts,
    [
      event(1, { type: 'user_prompt', text: 'first prompt', image_count: 0 }),
      event(2, { type: 'assistant_chunk', text: 'first reply' }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => [message.msgType, message.content]),
    [
      ['user', 'first prompt'],
      ['assistant', 'first reply'],
      ['user', 'second prompt'],
    ],
  );
});

test('keeps the unconfirmed initial prompt before legacy event streams', async () => {
  const {
    buildBaseMessages,
    buildMessagesFromEvents,
    splitLocalUserPromptsForReplay,
  } = await importWorkspaceEventTranscript();
  const split = splitLocalUserPromptsForReplay([
    { id: 'initial-user', text: 'initial prompt' },
  ]);

  const messages = buildMessagesFromEvents(
    buildBaseMessages([], split.initialPrompt),
    split.remainingPrompts,
    [
      event(1, { type: 'assistant_chunk', text: 'legacy reply without prompt event' }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => [message.msgType, message.content]),
    [
      ['user', 'initial prompt'],
      ['assistant', 'legacy reply without prompt event'],
    ],
  );
});

test('trims hydrated history before the first persisted native prompt', async () => {
  const { trimSeedMessagesBeforeFirstUserPrompt } = await importWorkspaceEventTranscript();
  const seedMessages = [
    { msgType: 'user', uuid: 'old-user', content: 'old prompt', segmentIndex: 0, isCompactBoundary: false },
    { msgType: 'assistant', uuid: 'old-assistant', content: 'old reply', segmentIndex: 0, isCompactBoundary: false },
    { msgType: 'user', uuid: 'live-user', content: 'resume prompt', segmentIndex: 0, isCompactBoundary: false },
    { msgType: 'assistant', uuid: 'live-assistant', content: 'resume reply', segmentIndex: 0, isCompactBoundary: false },
  ];

  const trimmed = trimSeedMessagesBeforeFirstUserPrompt(
    seedMessages,
    [
      event(1, { type: 'user_prompt', text: 'resume prompt', image_count: 0 }),
      event(2, { type: 'assistant_chunk', text: 'resume reply' }),
    ],
  );

  assert.deepEqual(
    trimmed.map((message) => message.uuid),
    ['old-user', 'old-assistant'],
  );
});

test('trims hydrated history when the provider prompt wraps the visible prompt', async () => {
  const { trimSeedMessagesBeforeFirstUserPrompt } = await importWorkspaceEventTranscript();
  const seedMessages = [
    { msgType: 'user', uuid: 'old-user', content: 'old prompt', segmentIndex: 0, isCompactBoundary: false },
    {
      msgType: 'user',
      uuid: 'wrapped-live-user',
      content: [
        {
          type: 'text',
          text: [
            'Stay in planning mode for this reply.',
            '',
            'resume prompt from composer',
          ].join('\n'),
        },
      ],
      segmentIndex: 0,
      isCompactBoundary: false,
    },
  ];

  const trimmed = trimSeedMessagesBeforeFirstUserPrompt(
    seedMessages,
    [
      event(1, { type: 'user_prompt', text: 'resume prompt from composer', image_count: 0 }),
    ],
  );

  assert.deepEqual(
    trimmed.map((message) => message.uuid),
    ['old-user'],
  );
});

test('trims hydrated skill prompt history when the native prompt has image attachments', async () => {
  const { trimSeedMessagesBeforeFirstUserPrompt } = await importWorkspaceEventTranscript();
  const seedMessages = [
    { msgType: 'user', uuid: 'old-user', content: 'old prompt', segmentIndex: 0, isCompactBoundary: false },
    {
      msgType: 'user',
      uuid: 'skill-image-user',
      content: [
        {
          type: 'text',
          text: [
            '<selected_skills>',
            '<skill name="lightweight-dev-mode" path="/Users/wzt/.claude/skills/lightweight-dev-mode/SKILL.md">',
            '<description>快速响应用户的软件开发需求</description>',
            '</skill>',
            '</selected_skills>',
            '',
            '<user_request>',
            '/lightweight-dev-mode transcript 展示的图片应该支持点击查看大图',
          ].join('\n'),
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        },
        { type: 'text', text: '</user_request>' },
      ],
      segmentIndex: 0,
      isCompactBoundary: false,
    },
  ];

  const trimmed = trimSeedMessagesBeforeFirstUserPrompt(
    seedMessages,
    [
      event(1, {
        type: 'user_prompt',
        text: '/lightweight-dev-mode transcript 展示的图片应该支持点击查看大图[Image #1]\n\nImages attached: 1',
        image_count: 1,
        images: [{
          mediaType: 'image/png',
          storagePath: 'prompt-image.png',
          placeholder: '[Image #1]',
        }],
      }),
    ],
  );

  assert.deepEqual(
    trimmed.map((message) => message.uuid),
    ['old-user'],
  );
});

test('trims hydrated multimodal skill prompts across CJK image boundaries without preserving artificial whitespace', async () => {
  const { trimSeedMessagesBeforeFirstUserPrompt } = await importWorkspaceEventTranscript();
  const promptTime = Date.parse('2026-05-01T00:00:01.000Z');
  const seedMessages = [
    { msgType: 'user', uuid: 'old-user', content: 'old prompt', timestamp: promptTime - 60_000, segmentIndex: 0, isCompactBoundary: false },
    {
      msgType: 'user',
      uuid: 'cjk-image-user',
      timestamp: promptTime,
      content: [
        {
          type: 'text',
          text: [
            '<selected_skills>',
            '<skill name="lightweight-dev-mode" path="/Users/wzt/.claude/skills/lightweight-dev-mode/SKILL.md">',
            '<description>快速响应用户的软件开发需求</description>',
            '</skill>',
            '</selected_skills>',
            '',
            '<user_request>',
            '/lightweight-dev-mode 我想给我们这个审查的面板',
          ].join('\n'),
        },
        {
          type: 'image',
          placeholder: '[Image #1]',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        },
        { type: 'text', text: '新增todo模块</user_request>' },
      ],
      segmentIndex: 0,
      isCompactBoundary: false,
    },
  ];

  const trimmed = trimSeedMessagesBeforeFirstUserPrompt(
    seedMessages,
    [
      eventAt(1, {
        type: 'user_prompt',
        text: '/lightweight-dev-mode 我想给我们这个审查的面板[Image #1]新增todo模块\n\nImages attached: 1',
        image_count: 1,
        images: [{
          mediaType: 'image/png',
          storagePath: 'prompt-image.png',
          placeholder: '[Image #1]',
        }],
      }, '2026-05-01T00:00:01.000Z'),
    ],
  );

  assert.deepEqual(
    trimmed.map((message) => message.uuid),
    ['old-user'],
  );
});

test('trims hydrated history at the latest timestamp-compatible prompt match instead of the first substring hit', async () => {
  const { trimSeedMessagesBeforeFirstUserPrompt } = await importWorkspaceEventTranscript();
  const seedMessages = [
    { msgType: 'user', uuid: 'old-user', content: 'old prompt', timestamp: Date.parse('2026-05-01T00:00:00.000Z'), segmentIndex: 0, isCompactBoundary: false },
    { msgType: 'assistant', uuid: 'old-assistant', content: 'old reply', timestamp: Date.parse('2026-05-01T00:00:01.000Z'), segmentIndex: 0, isCompactBoundary: false },
    {
      msgType: 'user',
      uuid: 'old-substring-user',
      content: '请继续处理这个审查面板 todo 模块的设计方案',
      timestamp: Date.parse('2026-05-01T00:01:00.000Z'),
      segmentIndex: 0,
      isCompactBoundary: false,
    },
    { msgType: 'assistant', uuid: 'old-substring-assistant', content: 'old related reply', timestamp: Date.parse('2026-05-01T00:01:02.000Z'), segmentIndex: 0, isCompactBoundary: false },
    {
      msgType: 'user',
      uuid: 'live-user',
      content: '继续处理这个审查面板 todo 模块',
      timestamp: Date.parse('2026-05-01T00:20:00.000Z'),
      segmentIndex: 0,
      isCompactBoundary: false,
    },
    { msgType: 'assistant', uuid: 'live-assistant', content: 'provider live reply', timestamp: Date.parse('2026-05-01T00:20:02.000Z'), segmentIndex: 0, isCompactBoundary: false },
  ];

  const trimmed = trimSeedMessagesBeforeFirstUserPrompt(
    seedMessages,
    [
      eventAt(1, {
        type: 'user_prompt',
        text: '继续处理这个审查面板 todo 模块',
        image_count: 0,
      }, '2026-05-01T00:20:00.000Z'),
    ],
  );

  assert.deepEqual(
    trimmed.map((message) => message.uuid),
    ['old-user', 'old-assistant', 'old-substring-user', 'old-substring-assistant'],
  );
});

test('selects provider seed by persisted boundary count before text matching', async () => {
  const { selectSeedMessagesForNativeReplay } = await importWorkspaceEventTranscript();
  const seedMessages = [
    { msgType: 'user', uuid: 'seed-user-1', content: 'first history prompt', segmentIndex: 0, isCompactBoundary: false },
    { msgType: 'assistant', uuid: 'seed-assistant-1', content: 'first history reply', segmentIndex: 0, isCompactBoundary: false },
    { msgType: 'user', uuid: 'repeated-live-user', content: '继续处理这个审查面板 todo 模块', segmentIndex: 0, isCompactBoundary: false },
    { msgType: 'assistant', uuid: 'provider-live-reply', content: 'provider live reply', segmentIndex: 0, isCompactBoundary: false },
  ];

  const selected = selectSeedMessagesForNativeReplay(
    seedMessages,
    {
      gap_detected: false,
      oldest_available_seq: 1,
      newest_available_seq: 3,
      events: [
        event(1, { type: 'lifecycle', stage: 'runtime_boot', detail: 'Starting claude native runtime.' }),
        event(2, { type: 'user_prompt', text: 'different hook-rewritten prompt', image_count: 0 }),
        event(3, { type: 'assistant_chunk', text: 'native live reply' }),
      ],
    },
    2,
  );

  assert.deepEqual(
    selected.map((message) => message.uuid),
    ['seed-user-1', 'seed-assistant-1'],
  );
});

test('selects no provider seed when native replay covers the runtime start', async () => {
  const { selectSeedMessagesForNativeReplay } = await importWorkspaceEventTranscript();
  const seedMessages = [
    { msgType: 'user', uuid: 'provider-user', content: '<selected_skills>wrapped</selected_skills>', segmentIndex: 0, isCompactBoundary: false },
    { msgType: 'assistant', uuid: 'provider-assistant', content: 'provider answer', segmentIndex: 0, isCompactBoundary: false },
  ];

  const selected = selectSeedMessagesForNativeReplay(
    seedMessages,
    {
      gap_detected: false,
      oldest_available_seq: 1,
      newest_available_seq: 4,
      events: [
        event(1, { type: 'lifecycle', stage: 'runtime_boot', detail: 'Starting claude native runtime.' }),
        event(2, { type: 'user_prompt', text: '/lightweight-dev-mode 真实 prompt', image_count: 0 }),
        event(3, { type: 'assistant_chunk', text: 'native replay answer' }),
        event(4, { type: 'lifecycle', stage: 'turn_completed', detail: '' }),
      ],
    },
    null,
  );

  assert.deepEqual(selected, []);
});

test('keeps provider seed when native replay has retained anchors but missing event ranges', async () => {
  const { selectSeedMessagesForNativeReplay } = await importWorkspaceEventTranscript();
  const seedMessages = [
    { msgType: 'user', uuid: 'provider-user', content: 'original prompt', segmentIndex: 0, isCompactBoundary: false },
    { msgType: 'assistant', uuid: 'provider-assistant', content: 'provider answer', segmentIndex: 0, isCompactBoundary: false },
  ];

  const selected = selectSeedMessagesForNativeReplay(
    seedMessages,
    {
      gap_detected: false,
      truncated: true,
      oldest_available_seq: 1,
      newest_available_seq: 10,
      events: [
        event(1, { type: 'lifecycle', stage: 'runtime_boot', detail: 'Starting claude native runtime.' }),
        event(2, { type: 'user_prompt', text: 'native prompt', image_count: 0 }),
        event(10, { type: 'assistant_chunk', text: 'tail answer' }),
      ],
    },
    null,
  );

  assert.deepEqual(
    selected.map((message) => message.uuid),
    ['provider-user', 'provider-assistant'],
  );
});

test('skips provider seed hydration when the native boundary proves replay ownership', async () => {
  const { shouldSkipProviderSeedHydration } = await importWorkspaceEventTranscript();
  const runtimeStartReplay = {
    gap_detected: false,
    oldest_available_seq: 1,
    newest_available_seq: 4,
    events: [
      event(1, { type: 'lifecycle', stage: 'runtime_boot', detail: 'Starting claude native runtime.' }),
      event(2, { type: 'user_prompt', text: '/lightweight-dev-mode 真实 prompt', image_count: 0 }),
      event(3, { type: 'assistant_chunk', text: 'native replay answer' }),
      event(4, { type: 'lifecycle', stage: 'turn_completed', detail: '' }),
    ],
  };

  assert.equal(shouldSkipProviderSeedHydration(runtimeStartReplay, 0), true);
  assert.equal(shouldSkipProviderSeedHydration(runtimeStartReplay, null), true);
  assert.equal(shouldSkipProviderSeedHydration(runtimeStartReplay, 2), false);
  assert.equal(shouldSkipProviderSeedHydration({ ...runtimeStartReplay, oldest_available_seq: 2 }, null), false);
  assert.equal(shouldSkipProviderSeedHydration({ ...runtimeStartReplay, truncated: true }, null), false);
  assert.equal(shouldSkipProviderSeedHydration(null, 0), false);
});

test('detects whether a replay batch continuously covers its available sequence range', async () => {
  const { replayBatchCoversAvailableSequenceRange } = await importWorkspaceEventTranscript();
  const completeReplay = {
    gap_detected: false,
    oldest_available_seq: 1,
    newest_available_seq: 3,
    events: [
      event(1, { type: 'lifecycle', stage: 'runtime_boot', detail: '' }),
      event(2, { type: 'user_prompt', text: 'prompt', image_count: 0 }),
      event(3, { type: 'assistant_chunk', text: 'answer' }),
    ],
  };

  assert.equal(replayBatchCoversAvailableSequenceRange(completeReplay), true);
  assert.equal(replayBatchCoversAvailableSequenceRange({
    ...completeReplay,
    events: [completeReplay.events[0], completeReplay.events[2]],
  }), false);
  assert.equal(replayBatchCoversAvailableSequenceRange({
    ...completeReplay,
    truncated: true,
  }), false);
});

test('live transcript trims duplicated hydrated skill prompt before replaying native events', async () => {
  const { buildMessagesFromEvents } = await importWorkspaceEventTranscript();
  const seedMessages = [
    {
      msgType: 'user',
      uuid: 'skill-image-user',
      content: [
        {
          type: 'text',
          text: [
            '<selected_skills>',
            '<skill name="lightweight-dev-mode" path="/Users/wzt/.claude/skills/lightweight-dev-mode/SKILL.md">',
            '<description>快速响应用户的软件开发需求</description>',
            '</skill>',
            '</selected_skills>',
            '',
            '<user_request>',
            '/lightweight-dev-mode transcript 展示的图片应该支持点击查看大图',
          ].join('\n'),
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        },
        { type: 'text', text: '</user_request>' },
      ],
      segmentIndex: 0,
      isCompactBoundary: false,
    },
    {
      msgType: 'assistant',
      uuid: 'hydrated-assistant',
      content: 'provider history answer',
      segmentIndex: 0,
      isCompactBoundary: false,
    },
  ];

  const messages = buildMessagesFromEvents(
    seedMessages,
    [],
    [
      event(1, {
        type: 'user_prompt',
        text: '/lightweight-dev-mode transcript 展示的图片应该支持点击查看大图[Image #1]\n\nImages attached: 1',
        image_count: 1,
        images: [{
          mediaType: 'image/png',
          storagePath: 'prompt-image.png',
          placeholder: '[Image #1]',
        }],
      }),
      event(2, { type: 'assistant_chunk', text: 'native replay answer' }),
      event(3, { type: 'lifecycle', stage: 'turn_completed', detail: '' }),
    ],
  );

  assert.deepEqual(
    messages.map((message) => message.uuid),
    ['user-prompt-1', 'assistant-turn-2'],
  );
  assert.equal(messages[0].content[0].text, '/lightweight-dev-mode transcript 展示的图片应该支持点击查看大图');
  assert.equal(messages[0].content[1].type, 'image');
  assert.match(JSON.stringify(messages[1].content), /native replay answer/);
});

test('local optimistic prompts are confirmed with the same identity normalization as persisted user prompts', async () => {
  const { filterConfirmedLocalUserPrompts } = await importWorkspaceEventTranscript();

  const pending = filterConfirmedLocalUserPrompts(
    [
      {
        id: 'local-cjk-image',
        text: '/lightweight-dev-mode 我想给我们这个审查的面板[Image #1]新增todo模块',
        images: [{ mediaType: 'image/png', storagePath: 'prompt-image.png', placeholder: '[Image #1]' }],
      },
      { id: 'still-pending', text: 'another prompt' },
    ],
    [
      event(1, {
        type: 'user_prompt',
        text: '/lightweight-dev-mode 我想给我们这个审查的面板新增todo模块\n\nImages attached: 1',
        image_count: 1,
        images: [{ mediaType: 'image/png', storagePath: 'prompt-image.png', placeholder: '[Image #1]' }],
      }),
    ],
  );

  assert.deepEqual(
    pending.map((prompt) => prompt.id),
    ['still-pending'],
  );
});

test('stabilizes unchanged message references but updates visible tool metadata changes', async () => {
  const {
    buildMessagesFromEvents,
    stabilizeMessageRefs,
  } = await importWorkspaceEventTranscript();

  const base = [
    { msgType: 'user', uuid: 'user-1', content: 'run', segmentIndex: 0, isCompactBoundary: false },
  ];
  const first = buildMessagesFromEvents(base, [], [
    event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
    event(2, { type: 'tool_use_started', tool_use_id: 'tool-1', raw_name: 'Bash', input_summary: 'pnpm test', needs_response: false, category: { category: 'execution', raw_name: 'Bash' } }),
    event(3, { type: 'tool_use_completed', tool_use_id: 'tool-1', raw_name: 'Bash', result_summary: 'ok', success: true }),
  ]);
  const same = buildMessagesFromEvents(base, [], [
    event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
    event(2, { type: 'tool_use_started', tool_use_id: 'tool-1', raw_name: 'Bash', input_summary: 'pnpm test', needs_response: false, category: { category: 'execution', raw_name: 'Bash' } }),
    event(3, { type: 'tool_use_completed', tool_use_id: 'tool-1', raw_name: 'Bash', result_summary: 'ok', success: true }),
  ]);
  const stabilized = stabilizeMessageRefs(same, first);
  assert.equal(stabilized[1], first[1]);

  const changedInput = buildMessagesFromEvents(base, [], [
    event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
    event(2, { type: 'tool_use_started', tool_use_id: 'tool-1', raw_name: 'Bash', input_summary: 'pnpm build', needs_response: false, category: { category: 'execution', raw_name: 'Bash' } }),
    event(3, { type: 'tool_use_completed', tool_use_id: 'tool-1', raw_name: 'Bash', result_summary: 'ok', success: true }),
  ]);
  const changedStabilized = stabilizeMessageRefs(changedInput, first);
  assert.notEqual(changedStabilized[1], first[1]);

  const changedTiming = buildMessagesFromEvents(base, [], [
    event(1, { type: 'lifecycle', stage: 'turn_started', detail: '' }),
    event(4, { type: 'tool_use_started', tool_use_id: 'tool-1', raw_name: 'Bash', input_summary: 'pnpm test', needs_response: false, category: { category: 'execution', raw_name: 'Bash' } }),
    event(5, { type: 'tool_use_completed', tool_use_id: 'tool-1', raw_name: 'Bash', result_summary: 'ok', success: true }),
  ]);
  const timingStabilized = stabilizeMessageRefs(changedTiming, first);
  assert.notEqual(timingStabilized[1], first[1]);
});
