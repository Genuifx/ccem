import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importClaudeCheckpointsModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-claude-checkpoints-test-'));
  const outfile = path.join(tempDir, 'claudeFileCheckpoints.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'claudeFileCheckpoints.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function buildHelperWithMockClaudeSdk() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-claude-checkpoints-test-'));
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
              return {
                type: 'sdk',
                name: config.name,
                instance: {
                  _registeredTools: Object.fromEntries((config.tools || []).map((definition) => [definition.name, definition])),
                },
              };
            }

            function assertCheckpointOptions(options) {
              if (options.enableFileCheckpointing !== true) {
                throw new Error('expected enableFileCheckpointing');
              }
              if (!options.extraArgs || options.extraArgs['replay-user-messages'] !== null) {
                throw new Error('expected replay-user-messages extra arg');
              }
            }

            export function query({ prompt, options }) {
              assertCheckpointOptions(options);
              let closed = false;
              return {
                close() {
                  closed = true;
                },
                async rewindFiles(checkpointId) {
                  if (checkpointId !== 'checkpoint-1') {
                    return { canRewind: false, error: 'unexpected checkpoint' };
                  }
                  return {
                    canRewind: true,
                    filesChanged: ['example.txt'],
                    insertions: 0,
                    deletions: 3,
                  };
                },
                async *[Symbol.asyncIterator]() {
                  const session_id = 'mock-session';
                  if (typeof prompt === 'string') {
                    yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                    return;
                  }

                  const iterator = prompt[Symbol.asyncIterator]();
                  const next = await iterator.next();
                  if (closed || next.done) return;
                  const userMessage = next.value.message;
                  yield { type: 'system', subtype: 'session_state_changed', state: 'running', session_id };
                  yield {
                    type: 'user',
                    uuid: 'checkpoint-1',
                    session_id,
                    parent_tool_use_id: null,
                    message: userMessage,
                  };
                  if (userMessage?.content === 'hold running') {
                    await new Promise(() => {});
                  }
                  yield {
                    type: 'result',
                    subtype: 'success',
                    result: 'done',
                    user_message_uuid: next.value.uuid,
                    session_id,
                  };
                  if (userMessage?.content === 'complete but stay open') {
                    await new Promise(() => {});
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

test('extracts checkpoint metadata from replayed Claude user messages', async () => {
  const { buildClaudeFileCheckpointEvent } = await importClaudeCheckpointsModule();

  const event = buildClaudeFileCheckpointEvent({
    type: 'user',
    uuid: ' checkpoint-1 ',
    session_id: 'session-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'Refactor auth\n\nand add tests' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ],
    },
  }, 'session-1');

  assert.deepEqual(event, {
    type: 'checkpoint_created',
    provider: 'claude',
    checkpoint_id: 'checkpoint-1',
    provider_session_id: 'session-1',
    prompt_summary: 'Refactor auth and add tests [image]',
    source: 'claude-file-checkpoint',
  });
});

test('ignores Claude tool result user messages for checkpoint extraction', async () => {
  const { buildClaudeFileCheckpointEvent } = await importClaudeCheckpointsModule();

  const event = buildClaudeFileCheckpointEvent({
    type: 'user',
    uuid: 'tool-result-message',
    session_id: 'session-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
      ],
    },
  }, 'session-1');

  assert.equal(event, null);
});

test('truncates checkpoint prompt summaries to the display limit', async () => {
  const { buildClaudeFileCheckpointEvent } = await importClaudeCheckpointsModule();
  const prompt = 'a'.repeat(180);

  const event = buildClaudeFileCheckpointEvent({
    type: 'user',
    uuid: 'checkpoint-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: prompt,
    },
  }, 'session-1');

  assert.equal(event.prompt_summary.length, 140);
  assert.equal(event.prompt_summary, `${'a'.repeat(137)}...`);
});

test('emits checkpoint and rewind events through the helper command stream', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const { outputs, stderrRef } = collectHelperOutput(helper);

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'edit example.txt',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'checkpoint_created'
      && output.payload.checkpoint_id === 'checkpoint-1'
      && output.payload.prompt_summary === 'edit example.txt',
    stderrRef,
    'checkpoint_created event',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready after initial Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'rewind_files',
    checkpoint_id: 'checkpoint-1',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'files_rewound'
      && output.payload.checkpoint_id === 'checkpoint-1'
      && output.payload.files_changed?.[0] === 'example.txt',
    stderrRef,
    'files_rewound event',
  );
});

test('rejects file rewind while Claude is still processing a turn', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const { outputs, stderrRef } = collectHelperOutput(helper);

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'hold running',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_started',
    stderrRef,
    'Claude running lifecycle',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'rewind_files',
    checkpoint_id: 'checkpoint-1',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'file_rewind_failed'
      && output.payload.checkpoint_id === 'checkpoint-1'
      && /Cannot rewind while Claude is processing/.test(output.payload.error),
    stderrRef,
    'file_rewind_failed while Claude is running',
  );
});

test('allows file rewind after a completed turn even if the Claude query has not closed', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const { outputs, stderrRef } = collectHelperOutput(helper);

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'complete but stay open',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready after completed Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'rewind_files',
    checkpoint_id: 'checkpoint-1',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'files_rewound'
      && output.payload.checkpoint_id === 'checkpoint-1',
    stderrRef,
    'files_rewound after completed but open query',
  );
});
