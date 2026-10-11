import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { startHelper, send, waitForOutput } from './claude-command-lifecycle-harness.mjs';

const bundled = await build({
  entryPoints: [new URL('../src/inputOperation.ts', import.meta.url).pathname],
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
