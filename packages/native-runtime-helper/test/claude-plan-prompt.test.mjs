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

async function buildHelperWithMockPlanTool(toolName) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-plan-prompt-test-'));
  const outfile = path.join(tempDir, 'native-runtime-helper.mjs');
  const safeToolName = JSON.stringify(toolName);

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
                  yield { type: 'system', subtype: 'session_state_changed', state: 'running', session_id };
                  await options.hooks.PreToolUse[0].hooks[0]({
                    hook_event_name: 'PreToolUse',
                    tool_name: ${safeToolName},
                    tool_input: {
                      description: 'Explore project files',
                      file_path: '/tmp/ccem-plan-demo.txt',
                    },
                    tool_use_id: 'tool-plan-test',
                  });
                  yield { type: 'result', subtype: 'success', result: 'done', session_id };
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

async function runPlanTool(toolName, t) {
  const helperPath = await buildHelperWithMockPlanTool(toolName);
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
    perm_mode: 'plan',
    working_dir: os.tmpdir(),
    initial_prompt: 'plan this change',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status' && output.status === 'ready',
    stderrRef,
    'ready status',
  );

  return outputs;
}

function hasSyntheticPlanExitPrompt(outputs) {
  return outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'tool_use_started'
    && output.payload?.raw_name === 'ExitPlanMode'
    && output.payload?.prompt?.prompt_type === 'plan_exit');
}

test('does not synthesize a plan exit prompt when a delegated Agent is used in plan mode', async (t) => {
  const outputs = await runPlanTool('Agent', t);

  assert.equal(hasSyntheticPlanExitPrompt(outputs), false);
});

test('does not synthesize a plan exit prompt when a mutating tool is blocked', async (t) => {
  const outputs = await runPlanTool('Write', t);

  assert.equal(hasSyntheticPlanExitPrompt(outputs), false);
});
