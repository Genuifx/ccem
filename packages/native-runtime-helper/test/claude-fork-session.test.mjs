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

async function buildHelperWithMockClaudeSdk() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-fork-session-test-'));
  const outfile = path.join(tempDir, 'native-runtime-helper.mjs');

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
              return { type: 'sdk', name: config.name, instance: {} };
            }

            export const forkCalls = [];

            export async function forkSession(sessionId, options = {}) {
              if (typeof sessionId !== 'string' || !sessionId) {
                throw new Error('forkSession requires a sessionId');
              }
              if (sessionId === 'fork-failure-parent') {
                throw new Error('mock fork failure');
              }
              if (options.upToMessageId !== 'cut-message-uuid') {
                throw new Error(\`unexpected upToMessageId: \${options.upToMessageId}\`);
              }
              if (options.dir !== '/tmp/ccem-fork-working-dir') {
                throw new Error(\`unexpected dir: \${options.dir}\`);
              }
              return { sessionId: 'forked-session-id' };
            }

            export function query({ prompt, options }) {
              if (options.resume !== 'forked-session-id' && options.resume !== 'fork-failure-parent') {
                throw new Error(\`unexpected resume target: \${options.resume}\`);
              }
              return {
                close() {},
                async *[Symbol.asyncIterator]() {
                  const session_id = options.resume;
                  const iterator = prompt[Symbol.asyncIterator]();
                  const next = await iterator.next();
                  if (next.done) return;
                  yield { type: 'system', subtype: 'session_state_changed', state: 'running', session_id };
                  yield {
                    type: 'user',
                    uuid: 'user-message-uuid',
                    session_id,
                    parent_tool_use_id: null,
                    message: next.value.message,
                  };
                  yield {
                    type: 'assistant',
                    uuid: 'cut-message-uuid',
                    session_id,
                    parent_tool_use_id: null,
                    message: {
                      role: 'assistant',
                      content: [{ type: 'text', text: 'Forked reply' }],
                    },
                  };
                  yield {
                    type: 'result',
                    subtype: 'success',
                    result: 'Forked reply',
                    user_message_uuid: next.value.uuid,
                    session_id,
                  };
                  await new Promise(() => {});
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

function collectHelperOutput(helper) {
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

  return { outputs, stderrRef };
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

function sendCommand(helper, command) {
  helper.stdin.write(`${JSON.stringify(command)}\n`);
}

test('init with fork_session forks the parent transcript and resumes the fork id', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const { outputs, stderrRef } = collectHelperOutput(helper);

  sendCommand(helper, {
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: '/tmp/ccem-fork-working-dir',
    initial_prompt: 'Start the forked conversation',
    provider_session_id: 'fork-parent-session',
    fork_session: true,
    fork_at_message_id: 'cut-message-uuid',
  });

  const sessionMeta = await waitForOutput(
    outputs,
    (output) => output.type === 'session_meta',
    stderrRef,
    'forked session_meta',
  );
  assert.equal(sessionMeta.provider_session_id, 'forked-session-id');

  const turnCompleted = await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload?.stage === 'turn_completed',
    stderrRef,
    'turn_completed with assistant_message_uuid',
  );
  assert.equal(turnCompleted.payload.assistant_message_uuid, 'cut-message-uuid');

  const errorStatuses = outputs.filter(
    (output) => output.type === 'status' && output.status === 'error',
  );
  assert.deepEqual(errorStatuses, []);
});

test('init without fork_session does not call forkSession', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const { outputs, stderrRef } = collectHelperOutput(helper);

  sendCommand(helper, {
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: '/tmp/ccem-fork-working-dir',
    initial_prompt: 'Continue the parent session',
    provider_session_id: 'fork-parent-session',
  });

  // The mock query throws when resumed against any id other than the forked id
  // or the parent itself, so reaching the parent session_meta proves no fork ran.
  const sessionMeta = await waitForOutput(
    outputs,
    (output) => output.type === 'session_meta',
    stderrRef,
    'parent session_meta',
  );
  assert.equal(sessionMeta.provider_session_id, 'fork-parent-session');
});

test('init with fork failure reports an error and does not start a turn', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const { outputs, stderrRef } = collectHelperOutput(helper);

  sendCommand(helper, {
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: '/tmp/ccem-fork-working-dir',
    initial_prompt: 'Should never run',
    provider_session_id: 'fork-failure-parent',
    fork_session: true,
    fork_at_message_id: 'cut-message-uuid',
  });

  const errorStatus = await waitForOutput(
    outputs,
    (output) => output.type === 'status' && output.status === 'error',
    stderrRef,
    'fork failure status',
  );
  assert.match(errorStatus.detail, /Failed to fork session: mock fork failure/);

  const sessionMetas = outputs.filter((output) => output.type === 'session_meta');
  assert.deepEqual(sessionMetas, [], 'no session_meta should be emitted when the fork fails');
});
