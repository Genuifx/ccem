import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHelper, send, waitForOutput, sleep, isLifecycle } from './claude-command-lifecycle-harness.mjs';

const helper = fileURLToPath(new URL('../dist/native-runtime-helper.mjs', import.meta.url));
const operations = (session, clientId) => session.outputs
  .filter((output) => output.type === 'event' && output.payload?.type === 'input_operation')
  .map((output) => output.payload)
  .filter((event) => clientId === undefined || event.client_message_ids.includes(clientId));
const isOperation = (clientId, stage) => (output) => output.type === 'event'
  && output.payload?.type === 'input_operation'
  && output.payload.client_message_ids.includes(clientId)
  && output.payload.stage === stage;

// Run the production helper and real bundled Codex SDK; only the executable
// transport is a fixture. This exercises independent processes and stdin/stdout.
async function codex(t, model) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-input-operation-'));
  const executable = path.join(dir, 'codex');
  const records = path.join(dir, 'calls.jsonl');
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
let text = '';
process.stdin.on('data', data => { text += data; });
process.stdin.on('end', () => {
 fs.appendFileSync(process.env.INPUT_PROBE, JSON.stringify({text,argv:process.argv.slice(2)})+'\\n');
 const emit = event => process.stdout.write(JSON.stringify(event)+'\\n');
 emit({type:'thread.started',thread_id:'input-operation-fixture'});
 emit({type:'turn.started'});
 if(text.includes('exit-error')) { process.exitCode=7; return; }
 if(text.includes('exhausted')) return;
 if(text.includes('fail-turn')) { emit({type:'turn.failed',error:{message:'fixture rejected turn'}}); return; }
 const finish = () => emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}});
 setTimeout(finish, text.includes('slow') ? 400 : 5);
});
`, { mode: 0o700 });
  const child = spawn(process.execPath, [helper], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: dir, INPUT_PROBE: records },
  });
  const session = { helper: child, outputs: [], stderrRef: { value: '' } };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    buffer += data;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) session.outputs.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (data) => { session.stderrRef.value += data; });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) {
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(1000)]);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  send(session, { type: 'init', provider: 'codex', env_name: '', perm_mode: 'readonly',
    working_dir: dir, codex_path: executable, ...(model ? { model } : {}) });
  await waitForOutput(session, (output) => output.type === 'status' && output.status === 'ready', 'Codex ready');
  session.calls = async () => (await fs.readFile(records, 'utf8')).trim().split('\n').map(JSON.parse);
  return session;
}

const executableFixture = { skip: process.platform === 'win32' ? 'Unix executable fixture.' : false };

test('Codex busy FIFO associates each SDK turn only with its own input', executableFixture, async (t) => {
  const session = await codex(t);
  send(session, { type: 'prompt', text: 'slow first', client_message_ids: ['a'] });
  await waitForOutput(session, isOperation('a', 'started'), 'first started');
  send(session, { type: 'prompt', text: 'second', client_message_ids: ['b'] });
  await sleep(60);
  assert.deepEqual(operations(session, 'b'), [], 'queued is not started');
  const completedA = await waitForOutput(session, isOperation('a', 'completed'), 'first completed');
  const completedB = await waitForOutput(session, isOperation('b', 'completed'), 'second completed');
  assert.deepEqual(operations(session, 'a').map((event) => event.stage), ['started', 'completed']);
  assert.deepEqual(operations(session, 'b').map((event) => event.stage), ['started', 'completed']);
  assert.notEqual(completedA.payload.operation_id, completedB.payload.operation_id);
  assert.equal(Object.hasOwn(completedA.payload, 'provider_turn_id'), false, 'SDK supplies no turn ID');
  assert.equal((await session.calls()).length, 2);
});

test('Codex repeated external client ID is a distinct execution, not a false dedup receipt', executableFixture, async (t) => {
  const session = await codex(t);
  send(session, { type: 'prompt', text: 'first', client_message_ids: ['duplicate'] });
  await waitForOutput(session, isOperation('duplicate', 'completed'), 'first completion');
  send(session, { type: 'prompt', text: 'second', client_message_ids: ['duplicate'] });
  await waitForOutput(session, () => operations(session, 'duplicate').filter((event) => event.stage === 'completed').length === 2,
    'second completion');
  const events = operations(session, 'duplicate');
  assert.equal(new Set(events.map((event) => event.operation_id)).size, 2);
  assert.equal((await session.calls()).length, 2, 'durable dedup belongs to bridge admission');
});

for (const model of [undefined, 'gpt-6-astra']) {
  test(`Codex explicit failed terminal remains failed (${model ?? 'default model'})`, executableFixture, async (t) => {
    const session = await codex(t, model);
    send(session, { type: 'prompt', text: 'fail-turn', client_message_ids: ['failed'] });
    await waitForOutput(session, isOperation('failed', 'failed'), 'provider failure');
    await sleep(30);
    assert.deepEqual(operations(session, 'failed').map((event) => event.stage), ['started', 'failed']);
  });
}

for (const text of ['exhausted', 'exit-error']) {
  test(`Codex ${text} does not fabricate a completed input`, executableFixture, async (t) => {
    const session = await codex(t);
    send(session, { type: 'prompt', text, client_message_ids: ['unknown'] });
    await waitForOutput(session, isOperation('unknown', 'unknown'), 'uncertain stream exit');
    assert.deepEqual(operations(session, 'unknown').map((event) => event.stage), ['started', 'unknown']);
  });
}

test('Codex runtime stop distinguishes an active unknown from never-dispatched queued input', executableFixture, async (t) => {
  const session = await codex(t);
  send(session, { type: 'prompt', text: 'slow first', client_message_ids: ['active'] });
  await waitForOutput(session, isOperation('active', 'started'), 'active input');
  send(session, { type: 'prompt', text: 'second', client_message_ids: ['queued'] });
  send(session, { type: 'stop' });
  await waitForOutput(session, isOperation('queued', 'failed'), 'queued cancellation');
  await waitForOutput(session, isOperation('active', 'unknown'), 'active interrupted outcome');
  assert.deepEqual(operations(session, 'queued').map((event) => event.stage), ['failed']);
  assert.equal((await session.calls()).length, 1);
});

test('Claude full lifecycle preserves all merged IDs and never completes a rejected overlap', async (t) => {
  const session = await startHelper(t, { terminalDelayMs: 200 });
  send(session, { type: 'prompt', text: 'merged batch', command_id: 'batch', client_message_ids: ['a', 'b'] });
  await waitForOutput(session, isOperation('a', 'started'), 'batch SDK start');
  await waitForOutput(session, (output) => isLifecycle(output, 'turn_result_observed', 'batch'), 'Result observation');
  send(session, { type: 'prompt', text: 'overlap', command_id: 'overlap', client_message_ids: ['rejected'] });
  await waitForOutput(session, isOperation('rejected', 'failed'), 'busy rejection');
  assert.deepEqual(operations(session, 'a').map((event) => event.stage), ['started']);
  const done = await waitForOutput(session, isOperation('a', 'completed'), 'actual command terminal');
  assert.deepEqual(done.payload.client_message_ids, ['a', 'b']);
  assert.equal(done.payload.command_id, 'batch');
  assert.deepEqual(operations(session, 'rejected').map((event) => event.stage), ['failed']);
  send(session, { type: 'prompt', text: 'next input', command_id: 'next', client_message_ids: ['next'] });
  const next = await waitForOutput(session, isOperation('next', 'completed'), 'next command terminal');
  assert.notEqual(done.payload.operation_id, next.payload.operation_id);
});

test('Claude unmatched provider terminal never completes the active input', async (t) => {
  const session = await startHelper(t, { scenario: 'mismatched_terminal', terminalDelayMs: 180 });
  send(session, { type: 'prompt', text: 'one', command_id: 'one', client_message_ids: ['one'] });
  await waitForOutput(session, (output) => isLifecycle(output, 'sdk_command_state', 'another-command', 'completed'), 'foreign terminal');
  assert.deepEqual(operations(session, 'one').map((event) => event.stage), ['started']);
  await waitForOutput(session, isOperation('one', 'completed'), 'matching terminal');
});

test('Claude LegacySerial waits for correlated Result and idle; uncorrelated input stays uncorrelated', async (t) => {
  const session = await startHelper(t, { scenario: 'legacy', terminalDelayMs: 180 });
  send(session, { type: 'prompt', text: 'legacy one', command_id: 'one', client_message_ids: ['one'] });
  await waitForOutput(session, (output) => isLifecycle(output, 'turn_result_observed', 'one'), 'legacy Result');
  assert.deepEqual(operations(session, 'one').map((event) => event.stage), ['started']);
  await waitForOutput(session, isOperation('one', 'completed'), 'legacy terminal');
  send(session, { type: 'prompt', text: 'untracked', command_id: 'two' });
  await waitForOutput(session, (output) => isLifecycle(output, 'legacy_turn_terminal', 'two'), 'untracked terminal');
  assert.equal(operations(session).length, 2, 'old client ID must not be borrowed');
});

for (const state of ['cancelled', 'discarded', 'refused']) {
  test(`Claude ${state} is correlated failure`, async (t) => {
    const session = await startHelper(t, { scenario: 'terminal_only', terminalState: state });
    send(session, { type: 'prompt', text: state, command_id: state, client_message_ids: ['failed'] });
    const output = await waitForOutput(session, isOperation('failed', 'failed'), 'failed terminal');
    assert.match(output.payload.detail, new RegExp(state));
    assert.equal(operations(session, 'failed').some((event) => event.stage === 'completed'), false);
  });
}

test('Claude legacy result without an echoed command ID remains unknown even after idle', async (t) => {
  const session = await startHelper(t, { scenario: 'legacy', omitResultCorrelation: true });
  send(session, { type: 'prompt', text: 'legacy', command_id: 'legacy', client_message_ids: ['legacy'] });
  await waitForOutput(session, (output) => isLifecycle(output, 'legacy_turn_terminal', 'legacy'), 'legacy UI terminal');
  await waitForOutput(session, isOperation('legacy', 'unknown'), 'uncorrelated legacy result');
  assert.equal(operations(session, 'legacy').some((event) => event.stage === 'completed'), false);
});

for (const scenario of ['query_failure', 'end_before_admission', 'missing_terminal', 'unknown']) {
  test(`Claude ${scenario} remains unknown without matching terminal`, async (t) => {
    const session = await startHelper(t, { scenario }, {}, { CCEM_NATIVE_LIFECYCLE_TERMINAL_TIMEOUT_MS: '80' });
    send(session, { type: 'prompt', text: scenario, command_id: 'unknown', client_message_ids: ['unknown'] });
    await waitForOutput(session, isOperation('unknown', 'unknown'), 'uncertain input');
    assert.equal(operations(session, 'unknown').some((event) => event.stage === 'completed'), false);
  });
}
