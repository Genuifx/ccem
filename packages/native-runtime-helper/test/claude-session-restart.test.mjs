import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function buildHelperWithMockClaudeSdk(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-claude-restart-test-'));
  const outfile = path.join(tempDir, 'native-runtime-helper.mjs');
  const firstResultSubtype = options.firstResultSubtype ?? 'success';
  const delayMsBeforeResult = options.delayMsBeforeResult ?? 0;
  const settleDelayMsAfterResult = options.settleDelayMsAfterResult ?? 0;
  const yieldIdleBeforeResult = options.yieldIdleBeforeResult ?? false;
  const interruptible = options.interruptible ?? false;
  const interruptHangs = options.interruptHangs ?? false;
  const logClose = options.logClose ?? false;
  const logCloseWithTurn = options.logCloseWithTurn ?? false;
  const logInterrupt = options.logInterrupt ?? false;
  const expectedQueryModel = options.expectedQueryModel ?? null;
  const reportModelState = options.reportModelState ?? false;
  const keepAliveAfterResult = options.keepAliveAfterResult ?? false;
  const endFirstTurnWithoutResult = options.endFirstTurnWithoutResult ?? false;

  await build({
    entryPoints: [path.join(packageDir, 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    plugins: [{
      name: 'mock-native-runtime-sdks',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
          path: 'claude-agent-sdk',
          namespace: 'mock-sdk',
        }));
        pluginBuild.onLoad({ filter: /^claude-agent-sdk$/, namespace: 'mock-sdk' }, () => ({
          loader: 'js',
          contents: `
            export function tool(name, description, inputSchema, handler) {
              return { name, description, inputSchema, handler };
            }

            export function createSdkMcpServer(config) {
              return {
                type: 'sdk',
                name: config.name,
                instance: {
                  _registeredTools: Object.fromEntries((config.tools || []).map((definition) => [definition.name, definition])),
                },
              };
            }

            const firstResultSubtype = ${JSON.stringify(firstResultSubtype)};
            const delayMsBeforeResult = ${JSON.stringify(delayMsBeforeResult)};
            const settleDelayMsAfterResult = ${JSON.stringify(settleDelayMsAfterResult)};
            const yieldIdleBeforeResult = ${JSON.stringify(yieldIdleBeforeResult)};
            const interruptible = ${JSON.stringify(interruptible)};
            const interruptHangs = ${JSON.stringify(interruptHangs)};
            const logClose = ${JSON.stringify(logClose)};
            const logCloseWithTurn = ${JSON.stringify(logCloseWithTurn)};
            const logInterrupt = ${JSON.stringify(logInterrupt)};
            const expectedQueryModel = ${JSON.stringify(expectedQueryModel)};
            const reportModelState = ${JSON.stringify(reportModelState)};
            const keepAliveAfterResult = ${JSON.stringify(keepAliveAfterResult)};
            const endFirstTurnWithoutResult = ${JSON.stringify(endFirstTurnWithoutResult)};
            let queryCount = 0;
            let setModelCalled = false;
            export function query({ prompt, options }) {
              if (expectedQueryModel !== null && options.model !== expectedQueryModel) {
                throw new Error('expected query model ' + expectedQueryModel + ', got ' + options.model);
              }
              const turn = ++queryCount;
              let closed = false;
              let interruptResolver = null;
              const waitForInterrupt = () => new Promise((resolve) => {
                interruptResolver = resolve;
              });
              return {
                close() {
                  closed = true;
                  if (logClose) {
                    process.stderr.write('__MOCK_CLAUDE_CLOSE__\\n');
                  }
                  if (logCloseWithTurn) {
                    process.stderr.write('__MOCK_CLAUDE_CLOSE_TURN_' + turn + '__\\n');
                  }
                  interruptResolver?.();
                },
                async interrupt() {
                  if (logInterrupt) {
                    process.stderr.write('__MOCK_CLAUDE_INTERRUPT__\\n');
                  }
                  if (interruptHangs) {
                    return new Promise(() => {});
                  }
                  interruptResolver?.();
                },
                async setModel() {
                  setModelCalled = true;
                },
                async *[Symbol.asyncIterator]() {
                  const iterator = prompt[Symbol.asyncIterator]();
                  const session_id = 'mock-session';
                  let localTurn = 0;
                  while (!closed) {
                    const next = await iterator.next();
                    if (closed || next.done) return;
                    localTurn += 1;
                    const responseNumber = (interruptible && !interruptHangs) || keepAliveAfterResult ? localTurn : turn;
                    const text = reportModelState
                      ? 'model=' + (options.model ?? '<none>') + ';setModel=' + setModelCalled
                      : 'mock response ' + responseNumber;
                    yield { type: 'system', subtype: 'session_state_changed', state: 'running', session_id };
                    yield {
                      type: 'assistant',
                      session_id,
                      message: { content: [{ type: 'text', text }] },
                    };
                    if (delayMsBeforeResult > 0) {
                      await new Promise((resolve) => setTimeout(resolve, delayMsBeforeResult));
                    }
                    if (interruptible && localTurn === 1) {
                      await waitForInterrupt();
                      if (closed) return;
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      yield { type: 'result', subtype: 'error_during_execution', errors: ['interrupted'], session_id };
                      continue;
                    }
                    if (yieldIdleBeforeResult) {
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                    }
                    if (endFirstTurnWithoutResult && turn === 1 && localTurn === 1) {
                      return;
                    }
                    if (!interruptible && turn === 1 && firstResultSubtype !== 'success') {
                      yield { type: 'result', subtype: firstResultSubtype, errors: ['hit turn limit'], session_id };
                    } else {
                      yield { type: 'result', subtype: 'success', result: 'done ' + responseNumber, session_id };
                    }
                    if (settleDelayMsAfterResult > 0) {
                      await new Promise((resolve) => setTimeout(resolve, settleDelayMsAfterResult));
                    }
                    if (!interruptible && !keepAliveAfterResult) return;
                  }
                },
              };
            }
          `,
        }));
        pluginBuild.onResolve({ filter: /^@openai\/codex-sdk$/ }, () => ({
          path: 'codex-sdk',
          namespace: 'mock-sdk',
        }));
        pluginBuild.onLoad({ filter: /^codex-sdk$/, namespace: 'mock-sdk' }, () => ({
          loader: 'js',
          contents: 'export class Codex {}',
        }));
      },
    }],
  });

  return outfile;
}

function waitForOutput(outputs, predicate, stderrRef, description) {
  const timeoutMs = 1_500;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const match = outputs.find(predicate);
      if (match) {
        resolve(match);
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error([
          `Timed out waiting for ${description}.`,
          `stdout=${JSON.stringify(outputs)}`,
          `stderr=${stderrRef.value}`,
        ].join('\n')));
        return;
      }

      setTimeout(check, 20);
    };

    check();
  });
}

function waitForStderr(stderrRef, pattern, description) {
  const timeoutMs = 1_500;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      if (pattern.test(stderrRef.value)) {
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error([
          `Timed out waiting for ${description}.`,
          `stderr=${stderrRef.value}`,
        ].join('\n')));
        return;
      }

      setTimeout(check, 20);
    };

    check();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('restarts Claude query after a completed turn so later prompts are consumed', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 1',
    stderrRef,
    'first Claude response',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after the first Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response',
  );

  const chunks = outputs
    .filter((output) => output.type === 'event' && output.payload?.type === 'assistant_chunk')
    .map((output) => output.payload.text);

  assert.deepEqual(chunks, ['mock response 1', 'mock response 2']);
});

test('keeps an idle Claude query open for the next prompt instead of closing background work', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logClose: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after the first persistent Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response on the same persistent query',
  );

  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_CLOSE__/);
});

test('stop closes an idle retained Claude query without interrupting a completed turn', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logClose: true,
    logInterrupt: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after completed retained Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`);

  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'idle retained Claude query closed on stop',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'idle_stop',
    stderrRef,
    'idle_stop lifecycle event',
  );

  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_interrupted'),
    false,
  );
});

test('idle stop closes the captured Claude query without closing a fresh prompt reconnect', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logCloseWithTurn: true,
    logInterrupt: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after retained Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'closed_idle'
      && output.detail === 'Claude runtime stopped after completed turn.',
    stderrRef,
    'closed_idle status after idle stop',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    () => outputs.filter((output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk').length >= 2,
    stderrRef,
    'fresh Claude response after idle stop',
  );

  await delay(60);
  const chunks = outputs
    .filter((output) => output.type === 'event' && output.payload?.type === 'assistant_chunk')
    .map((output) => output.payload.text);
  assert.deepEqual(
    chunks.slice(0, 2),
    ['mock response 1', 'mock response 1'],
    'closed_idle continuation starts from a fresh Claude query',
  );
  assert.match(stderrRef.value, /__MOCK_CLAUDE_CLOSE_TURN_1__/);
  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_CLOSE_TURN_2__/);
  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
});

test('closes an idle Claude query after the retention timeout', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logClose: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '40',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status before idle retention timeout',
  );

  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'idle Claude query close after retention timeout',
  );
});

test('restarts an idle retained Claude query before sending with updated environment settings', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logClose: true,
    reportModelState: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '60000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    env_vars: { ANTHROPIC_MODEL: 'old-model' },
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=old-model;setModel=false',
    stderrRef,
    'first Claude response with original environment model',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'update_settings',
    env_name: 'updated',
    env_vars: { ANTHROPIC_MODEL: 'new-model' },
  })}\n`);
  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Settings applied.',
    stderrRef,
    'applied settings status',
  );

  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'idle retained query close after environment update',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=new-model;setModel=false',
    stderrRef,
    'second Claude response with updated environment model',
  );
});

test('applies environment settings after the active Claude turn before accepting the next prompt', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    delayMsBeforeResult: 120,
    keepAliveAfterResult: true,
    logClose: true,
    reportModelState: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '60000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    env_vars: { ANTHROPIC_MODEL: 'old-model' },
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=old-model;setModel=false',
    stderrRef,
    'first Claude response while the turn remains active',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'update_settings',
    env_name: 'updated',
    env_vars: { ANTHROPIC_MODEL: 'new-model' },
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'processing'
      && output.detail === 'Settings will apply to the next Claude runtime.',
    stderrRef,
    'queued active-turn settings status',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Settings applied.',
    stderrRef,
    'settings applied after active turn completion',
  );

  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'active-turn query close after applying environment settings',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=new-model;setModel=false',
    stderrRef,
    'next Claude response with active-turn environment update',
  );
});

test('restarts Claude query when a prompt arrives after idle but before the old query settles', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    yieldIdleBeforeResult: true,
    settleDelayMsAfterResult: 80,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after the first Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response after idle-before-result race',
  );
});

test('passes Claude runtime model at query startup without setModel control request', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    expectedQueryModel: 'opus',
    reportModelState: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    env_vars: {
      ANTHROPIC_MODEL: ' opus ',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-test',
    },
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=opus;setModel=false',
    stderrRef,
    'Claude query model without setModel',
  );
});

test('marks Claude helper ready after a non-success result so the workspace can continue', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    firstResultSubtype: 'error_max_turns',
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'session_completed'
      && output.payload.reason === 'hit turn limit',
    stderrRef,
    'non-success Claude completion event',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after non-success Claude result',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response',
  );
});

test('preserves partial output, reports one incomplete response, and recovers the next Claude prompt', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    endFirstTurnWithoutResult: true,
    yieldIdleBeforeResult: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';
  const incompleteReason = 'Claude response ended before a final result. Partial output was preserved; send the next prompt to retry.';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 1',
    stderrRef,
    'partial Claude response before the missing result',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'session_completed'
      && output.payload.reason === incompleteReason,
    stderrRef,
    'recoverable incomplete-response error',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Claude response incomplete. Ready to retry.',
    stderrRef,
    'ready status after the incomplete response',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response after reconnect',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after the recovered response',
  );

  assert.equal(
    outputs.filter((output) => output.type === 'event'
      && output.payload?.type === 'session_completed'
      && output.payload.reason === incompleteReason).length,
    1,
  );
  assert.deepEqual(
    outputs
      .filter((output) => output.type === 'event' && output.payload?.type === 'assistant_chunk')
      .map((output) => output.payload.text),
    ['mock response 1', 'mock response 2'],
  );
});

test('interrupts an active Claude turn without closing the query process', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    interruptible: true,
    logClose: true,
    logInterrupt: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 1',
    stderrRef,
    'first Claude response before interrupt',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_interrupted',
    stderrRef,
    'turn_interrupted lifecycle event',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Turn interrupted. Ready for the next prompt.',
    stderrRef,
    'ready status after interrupt',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response after interrupt',
  );

  assert.match(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_CLOSE__/);
  assert.equal(
    outputs.some((output) => output.type === 'event' && output.payload?.type === 'session_completed'),
    false,
  );
});

test('times out a stuck Claude interrupt and restarts the next prompt on a fresh query', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    interruptible: true,
    interruptHangs: true,
    logClose: true,
    logCloseWithTurn: true,
    logInterrupt: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_INTERRUPT_TIMEOUT_MS: '40',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 1',
    stderrRef,
    'first Claude response before stuck interrupt',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'interrupt_requested',
    stderrRef,
    'interrupt_requested lifecycle event',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'interrupt_timeout',
    stderrRef,
    'interrupt_timeout lifecycle event',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'interrupted'
      && output.detail === 'Claude interrupt timed out; runtime will reconnect on the next prompt.',
    stderrRef,
    'interrupted status after interrupt timeout',
  );

  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'stuck Claude query closed after interrupt timeout',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response after interrupt timeout',
  );

  assert.match(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
  assert.match(stderrRef.value, /__MOCK_CLAUDE_CLOSE_TURN_1__/);
  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_CLOSE_TURN_2__/);
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_interrupted'),
    false,
  );
});

test('does not drop prompts sent while a completed one-shot Claude query is settling', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    settleDelayMsAfterResult: 120,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status before one-shot query settles',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response after settling restart',
  );
});
