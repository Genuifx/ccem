import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-session-handoff-'));
const outfile = path.join(temp, 'bridge.mjs');
await build({ entryPoints: [fileURLToPath(new URL('../src/sessionHandoffMcp.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
const { createSessionHandoffBridge, createOwnedSessionHandoffSender, createCcemSessionHandoffMcpServer, ensureSessionHandoffToolAllowed, SESSION_HANDOFF_TOOL_NAME, MAX_PENDING_SESSION_HANDOFFS } = await import(pathToFileURL(outfile).href);
test.after(() => fs.rm(temp, { recursive: true, force: true }));

test('actual SDK tool emits one request and returns submitted only after host acceptance', async () => {
  const requests = [];
  const bridge = createSessionHandoffBridge((request) => requests.push(request));
  const server = createCcemSessionHandoffMcpServer(() => 'dev', (target, text) => bridge.sendMessage(target, text, {query_generation:1, command_id:'cmd-1'}));
  const pending = server.instance._registeredTools.send_message.handler({ target_runtime_id: 'native-target', text: 'Please run the tests.' });
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0]).sort(), ['command_id', 'query_generation', 'request_id', 'target_runtime_id', 'text', 'type']);
  assert.equal(requests[0].type, 'session_handoff_request');
  assert.equal(bridge.handleResponse({ type: 'session_handoff_response', request_id: 'unknown', ok: true }), false);
  bridge.handleResponse({ type: 'session_handoff_response', request_id: requests[0].request_id, ok: true });
  assert.deepEqual(JSON.parse((await pending).content[0].text), { status: 'submitted', target_runtime_id: 'native-target' });
});

test('dynamic permission modes prevent transport and allowedTools only adds in sending modes', async () => {
  let mode = 'dev';
  let sends = 0;
  const handler = createCcemSessionHandoffMcpServer(() => mode, async () => { sends++; }).instance._registeredTools.send_message.handler;
  for (mode of ['readonly', 'audit', 'plan', 'safe', 'ci', 'custom']) {
    await assert.rejects(handler({ target_runtime_id: 'native-target', text: 'hello' }), /blocked/);
    assert.deepEqual(ensureSessionHandoffToolAllowed(['Read'], mode), ['Read']);
  }
  assert.equal(sends, 0);
  for (mode of ['dev', 'yolo', 'bypassPermissions']) {
    await handler({ target_runtime_id: 'native-target', text: 'hello' });
    assert.deepEqual(ensureSessionHandoffToolAllowed(undefined, mode), [SESSION_HANDOFF_TOOL_NAME]);
  }
  assert.equal(sends, 3);
  assert.deepEqual(ensureSessionHandoffToolAllowed(['Read', SESSION_HANDOFF_TOOL_NAME], 'dev'), ['Read', SESSION_HANDOFF_TOOL_NAME]);
});

test('payload limits reject empty, oversized, or invalid targets before transport', async () => {
  let sends = 0;
  const handler = createCcemSessionHandoffMcpServer(() => 'dev', async () => { sends++; }).instance._registeredTools.send_message.handler;
  for (const input of [{ target_runtime_id: '../bad', text: 'a' }, { target_runtime_id: 'native-ok', text: ' ' }, { target_runtime_id: 'native-ok', text: '中'.repeat(12001) }]) {
    await assert.rejects(handler(input));
  }
  await handler({ target_runtime_id: 'native-ok', text: '😀'.repeat(12000) });
  assert.equal(sends, 1);
});

test('receipt can arrive synchronously without being lost and rejection never retries', async () => {
  let count = 0;
  const bridge = createSessionHandoffBridge((request) => {
    count++;
    bridge.handleResponse({ type: 'session_handoff_response', request_id: request.request_id, ok: false, error: 'Receiver inactive' });
  });
  await assert.rejects(bridge.sendMessage('native-target', 'hello', {query_generation:1, command_id:'cmd-1'}), /Receiver inactive.*Do not retry/);
  assert.equal(count, 1);
});

test('timeout is uncertain, ignores late receipt and never retries', async () => {
  const requests = [];
  const bridge = createSessionHandoffBridge((request) => requests.push(request), 5);
  await assert.rejects(bridge.sendMessage('native-target', 'hello', {query_generation:1, command_id:'cmd-1'}), /uncertain.*Do not retry/);
  assert.equal(requests.length, 1);
  assert.equal(bridge.handleResponse({ type: 'session_handoff_response', request_id: requests[0].request_id, ok: true }), false);
});

test('pending requests are bounded and shutdown rejects outstanding receipts', async () => {
  const requests = [];
  const bridge = createSessionHandoffBridge((request) => requests.push(request));
  const pending = Array.from({ length: MAX_PENDING_SESSION_HANDOFFS }, () => bridge.sendMessage('native-target', 'hello', {query_generation:1, command_id:'cmd-1'}));
  const rejected = pending.map((promise) => assert.rejects(promise, /Session closed.*uncertain/));
  await assert.rejects(bridge.sendMessage('native-target', 'hello', {query_generation:1, command_id:'cmd-1'}), /Too many/);
  assert.equal(requests.length, MAX_PENDING_SESSION_HANDOFFS);
  bridge.rejectAll();
  await Promise.all(rejected);
});

// The model decision is scripted; the subprocess protocol and helper integration are real.
import { startHelper, send, waitForOutput, isLifecycle } from './claude-command-lifecycle-harness.mjs';
test('helper subprocess routes MCP send through host response without permission dialog', async (t) => {
  const session = await startHelper(t, { scenario: 'session_handoff' }, {
    perm_mode: 'dev', initial_prompt: '@recipient Please send him: Please run the tests.', initial_command_id: 'handoff-command',
    disallowed_tools: ['Bash'],
  });
  const request = await waitForOutput(session, (output) => output.type === 'session_handoff_request', 'host handoff request');
  assert.equal(request.target_runtime_id, 'native-recipient');
  assert.equal(request.text, 'Please run the tests.');
  assert.equal(request.query_generation, 1);
  assert.equal(request.command_id, 'handoff-command');
  assert.equal(session.outputs.filter((output) => output.type === 'handoff_probe').length, 0);
  send(session, { type: 'session_handoff_response', request_id: request.request_id, ok: true });
  const probe = await waitForOutput(session, (output) => output.type === 'handoff_probe', 'MCP receipt');
  assert.equal(JSON.parse(probe.result.content[0].text).status, 'submitted');
  assert.ok(probe.allowedTools.includes(SESSION_HANDOFF_TOOL_NAME));
  assert.deepEqual(probe.disallowedTools, ['Bash']);
  assert.equal(session.outputs.filter((output) => output.type === 'session_handoff_request').length, 1);
  assert.equal(session.outputs.filter((output) => output.payload?.type === 'permission_requested').length, 0);
});

test('reference-only helper turn has no handoff effect', async (t) => {
  const session = await startHelper(t, { scenario: 'full' }, {
    perm_mode: 'dev', initial_prompt: '@recipient Reference this session only.', initial_command_id: 'reference-command',
  });
  await waitForOutput(session, (output) => isLifecycle(output, 'sdk_command_state', 'reference-command', 'completed'), 'reference turn completion');
  assert.equal(session.outputs.filter((output) => output.type === 'session_handoff_request').length, 0);
});

test('old MCP callback is fenced after query replacement or foreground stop', async () => {
  let owner = { query_generation: 1, command_id: 'cmd-1' };
  const requests = [];
  const sender = createOwnedSessionHandoffSender(1, () => owner, async (...args) => { requests.push(args); });
  const handler = createCcemSessionHandoffMcpServer(() => 'dev', sender).instance._registeredTools.send_message.handler;
  await handler({ target_runtime_id: 'native-target', text: 'hello' });
  assert.deepEqual(requests[0][2], owner);
  owner = { query_generation: 2, command_id: 'cmd-2' };
  await assert.rejects(handler({ target_runtime_id: 'native-target', text: 'stale query' }), /stale or stopped/);
  owner = null;
  await assert.rejects(handler({ target_runtime_id: 'native-target', text: 'stopped turn' }), /stale or stopped/);
  assert.equal(requests.length, 1);
});
