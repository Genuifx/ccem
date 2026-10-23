import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { startHelper, send, waitForOutput } from './claude-command-lifecycle-harness.mjs';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/inputOperation.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
});
const { InputOperation } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const metrics = (outputs) => outputs.filter((event) => event.type === 'turn_metrics');

test('completed turn freezes monotonic duration, excludes queue and late usage delay, emits once', () => {
  let now = 10;
  const events = [];
  const op = new InputOperation('codex', ['user'], (e) => events.push(e), 'command', () => now);
  now = 10_000;
  op.observe('started', 'start');
  now = 10_500;
  op.observe('started', 'duplicate start');
  op.observe('completed', 'done');
  now = 20_000;
  op.recordOutputTokens(125);
  op.recordOutputTokens(999);
  op.observe('completed', 'duplicate terminal');
  assert.deepEqual(metrics(events), [{ type: 'turn_metrics', operation_id: op.id,
    provider: 'codex', output_tokens: 125, elapsed_ms: 500 }]);
});

test('missing/invalid usage, failed, unknown and never-started operations have no fabricated rate', () => {
  for (const stage of ['completed', 'failed', 'unknown']) {
    for (const count of [undefined, NaN, Infinity, -1, 1.5, '10']) {
      let now = 1;
      const events = [];
      const op = new InputOperation('claude', ['user'], (e) => events.push(e), undefined, () => now);
      op.observe('started', 'start');
      op.recordOutputTokens(count);
      now = 100;
      op.observe(stage, 'terminal');
      assert.equal(metrics(events).length, 0);
    }
  }
  for (const stage of ['failed', 'unknown']) {
    const events = [];
    const op = new InputOperation('claude', ['user'], (e) => events.push(e));
    op.observe('started', 'start');
    op.recordOutputTokens(10);
    op.observe(stage, 'terminal');
    assert.equal(metrics(events).length, 0);
  }
});

test('Claude integration emits a distinct metric for each correlated successful turn', async (t) => {
  const session = await startHelper(t, { resultDelayMs: 50 });
  for (const id of ['one', 'two']) {
    send(session, { type: 'prompt', text: id, command_id: id, client_message_ids: [id] });
    const completed = await waitForOutput(session, (o) => o.payload?.type === 'input_operation'
      && o.payload.command_id === id && o.payload.stage === 'completed', `${id} completed`);
    const measured = await waitForOutput(session, (o) => o.payload?.type === 'turn_metrics'
      && o.payload.operation_id === completed.payload.operation_id, `${id} measured`);
    assert.equal(measured.payload.output_tokens, 2);
    assert.ok(measured.payload.elapsed_ms >= 40);
  }
  assert.equal(session.outputs.filter((o) => o.payload?.type === 'turn_metrics').length, 2);
});

test('Claude initial prompt measures the first turn without inventing external client IDs', async (t) => {
  const session = await startHelper(t, { resultDelayMs: 30 }, {
    initial_prompt: 'first turn', initial_command_id: 'initial',
  });
  const measured = await waitForOutput(session, (o) => o.payload?.type === 'turn_metrics', 'initial metrics');
  const start = session.outputs.find((o) => o.payload?.type === 'input_operation' && o.payload.stage === 'started');
  assert.deepEqual(start.payload.client_message_ids, []);
  assert.equal(measured.payload.operation_id, start.payload.operation_id);
  assert.equal(measured.payload.output_tokens, 2);
});

test('Claude terminal-before-Result still measures its own execution without Result delivery delay', async (t) => {
  const session = await startHelper(t, { scenario: 'terminal_before_result', resultDelayMs: 40,
    terminalDelayMs: 220, lateForeignResults: true });
  send(session, { type: 'prompt', text: 'one', command_id: 'late', client_message_ids: ['late'] });
  await waitForOutput(session, (o) => o.payload?.type === 'input_operation' && o.payload.stage === 'completed', 'terminal');
  const result = await waitForOutput(session, (o) => o.payload?.type === 'token_usage' && o.payload.scope === 'turn_total', 'late usage');
  assert.equal(result.payload.output_tokens, 2);
  const measured = await waitForOutput(session, (o) => o.payload?.type === 'turn_metrics', 'own metric');
  assert.equal(measured.payload.output_tokens, 2, 'background/child Result cannot claim a human execution');
  assert.ok(measured.payload.elapsed_ms >= 30 && measured.payload.elapsed_ms < 220);
  assert.equal(session.outputs.filter((o) => o.payload?.type === 'token_usage' && o.payload.scope === 'turn_total').length, 1);
});

test('generation time sums first→last delta per response, excluding TTFT, tools and waiting', () => {
  let now = 0;
  const events = [];
  const op = new InputOperation('claude', ['user'], (e) => events.push(e), undefined, () => now);
  op.markOutputDelta(); // before start: ignored
  op.observe('started', 'start');
  op.markResponseStart();
  now = 1_000; op.markOutputDelta(); // 1s TTFT excluded
  now = 1_400; op.markOutputDelta();
  now = 5_000; op.markResponseStart(); // tool execution 1.4s→5s excluded
  now = 7_000; op.markOutputDelta();
  now = 7_100; op.markOutputDelta();
  now = 9_000; op.observe('completed', 'done');
  now = 9_500; op.markOutputDelta(); // after terminal: ignored
  op.recordOutputTokens(50);
  assert.deepEqual(metrics(events), [{ type: 'turn_metrics', operation_id: op.id,
    provider: 'claude', output_tokens: 50, elapsed_ms: 9_000, generation_ms: 500 }]);
});

test('turns without measurable streaming omit generation time instead of inventing one', () => {
  for (const deltas of [0, 1]) {
    let now = 0;
    const events = [];
    const op = new InputOperation('codex', ['user'], (e) => events.push(e), undefined, () => now);
    op.observe('started', 'start');
    for (let i = 0; i < deltas; i += 1) op.markOutputDelta();
    now = 1_000;
    op.observe('completed', 'done');
    op.recordOutputTokens(10);
    assert.equal(metrics(events)[0].generation_ms, undefined);
    assert.equal(metrics(events)[0].elapsed_ms, 1_000);
  }
});

test('Claude integration measures main-agent streaming only', async (t) => {
  const session = await startHelper(t, { streamDeltas: { responses: 2, ttftMs: 150, deltas: 3, gapMs: 40, toolMs: 150 } });
  send(session, { type: 'prompt', text: 'stream', command_id: 'stream', client_message_ids: ['stream'] });
  const measured = await waitForOutput(session, (o) => o.payload?.type === 'turn_metrics', 'streamed metrics');
  const { generation_ms: generationMs, elapsed_ms: elapsedMs } = measured.payload;
  // 2 responses × 2 gaps × 40ms ≈ 160ms; TTFT (2×150) and child/tool time (2×150) excluded.
  assert.ok(generationMs >= 150 && generationMs < 290, `generation ${generationMs}ms`);
  assert.ok(elapsedMs >= generationMs + 550, `elapsed ${elapsedMs}ms`);
});
