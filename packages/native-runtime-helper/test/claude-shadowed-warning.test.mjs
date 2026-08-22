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
const shadowedWarningCode = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';
const bypassWarning = "canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback is consulted. To gate every tool call, use a PreToolUse hook instead.";
const allowedToolsWarning = 'canUseTool will not be invoked: allowedTools is configured without an interactive permission path.';

async function importWarningModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-shadowed-warning-module-test-'));
  const outfile = path.join(tempDir, 'claudeSdkWarnings.mjs');
  await build({
    entryPoints: [path.join(packageDir, 'src', 'claudeSdkWarnings.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function buildHelperWithWarningMock() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-shadowed-warning-test-'));
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

            export async function forkSession() {
              throw new Error('forkSession should not be called in this test');
            }

            export function query({ prompt, options }) {
              process.emitWarning(${JSON.stringify(bypassWarning)}, {
                code: ${JSON.stringify(shadowedWarningCode)},
              });
              process.emitWarning(${JSON.stringify(allowedToolsWarning)}, {
                code: ${JSON.stringify(shadowedWarningCode)},
              });
              process.emitWarning('control warning remains visible', {
                code: 'CCEM_CONTROL_WARNING',
              });

              return {
                close() {},
                async getContextUsage() {
                  return {
                    totalTokens: 1,
                    maxTokens: 10,
                    rawMaxTokens: 10,
                    percentage: 10,
                    autoCompactThreshold: null,
                    isAutoCompactEnabled: false,
                    model: 'mock',
                    categories: [],
                  };
                },
                async *[Symbol.asyncIterator]() {
                  const iterator = prompt[Symbol.asyncIterator]();
                  const next = await iterator.next();
                  if (next.done) return;

                  const session_id = 'mock-session';
                  const input = {
                    questions: [{
                      question: 'Continue?',
                      header: 'Choice',
                      multiSelect: false,
                      options: [{ label: 'Yes', description: 'Continue the test.' }],
                    }],
                  };
                  yield { type: 'system', subtype: 'session_state_changed', state: 'running', session_id };
                  yield {
                    type: 'assistant',
                    session_id,
                    message: {
                      content: [{
                        type: 'tool_use',
                        id: 'toolu-ask-yolo',
                        name: 'AskUserQuestion',
                        input,
                      }],
                    },
                  };

                  const result = await options.canUseTool('AskUserQuestion', input, {
                    toolUseID: 'toolu-ask-yolo',
                  });
                  process.stderr.write('ASK_USER_RESULT ' + JSON.stringify(result) + '\\n');
                  yield {
                    type: 'result',
                    subtype: 'success',
                    result: 'done',
                    user_message_uuid: next.value.uuid,
                    session_id,
                  };
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
      if (line) outputs.push(JSON.parse(line));
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  return { outputs, stderrRef };
}

function waitFor(description, readValue, predicate) {
  const timeoutMs = 2_500;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const value = readValue();
      const match = predicate(value);
      if (match) {
        resolve(match);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}.\nvalue=${JSON.stringify(value)}`));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

test('restores process.emitWarning after successful or failed Claude query construction', async () => {
  const { withSuppressedClaudeBypassShadowWarning } = await importWarningModule();
  const originalEmitWarning = process.emitWarning;
  const bypassOptions = { permissionMode: 'bypassPermissions', canUseTool() {} };

  assert.equal(
    withSuppressedClaudeBypassShadowWarning(bypassOptions, () => 'query'),
    'query',
  );
  assert.equal(process.emitWarning, originalEmitWarning);

  assert.throws(
    () => withSuppressedClaudeBypassShadowWarning(
      bypassOptions,
      () => {
        throw new Error('query construction failed');
      },
    ),
    /query construction failed/u,
  );
  assert.equal(process.emitWarning, originalEmitWarning);
});

test('hides only the bypass shadow warning while preserving yolo user interaction', async (t) => {
  const helperPath = await buildHelperWithWarningMock();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

  const { outputs, stderrRef } = collectHelperOutput(helper);
  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'yolo',
    working_dir: os.tmpdir(),
    initial_prompt: 'ask before continuing',
  })}\n`);

  await waitFor(
    'AskUserQuestion event',
    () => outputs,
    (value) => value.find((output) => output.type === 'event'
      && output.payload?.type === 'tool_use_started'
      && output.payload?.tool_use_id === 'toolu-ask-yolo'
      && output.payload?.needs_response === true),
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'interactive_prompt_response',
    tool_use_id: 'toolu-ask-yolo',
    prompt_type: 'ask_user_question',
    answers: { 'Continue?': 'Yes' },
  })}\n`);

  await waitFor(
    'completed Claude turn',
    () => outputs,
    (value) => value.find((output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload?.stage === 'turn_completed'),
  );
  await waitFor(
    'preserved warning and AskUserQuestion proof',
    () => stderrRef.value,
    (value) => value.includes(allowedToolsWarning)
      && value.includes('CCEM_CONTROL_WARNING')
      && value.includes('ASK_USER_RESULT '),
  );

  assert.equal(stderrRef.value.includes(bypassWarning), false, stderrRef.value);
  assert.match(stderrRef.value, /\[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED\].*allowedTools/u);
  assert.match(stderrRef.value, /\[CCEM_CONTROL_WARNING\].*control warning remains visible/u);

  const proofLine = stderrRef.value
    .split('\n')
    .find((line) => line.startsWith('ASK_USER_RESULT '));
  const proof = JSON.parse(proofLine.slice('ASK_USER_RESULT '.length));
  assert.equal(proof.behavior, 'allow');
  assert.equal(proof.toolUseID, 'toolu-ask-yolo');
  assert.deepEqual(proof.updatedInput.answers, { 'Continue?': 'Yes' });
});
