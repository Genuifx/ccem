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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-title-query-test-'));
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
              if (!prompt.includes('ProjectTree')) {
                throw new Error('title query prompt missing ProjectTree context');
              }
              if (options.model !== 'claude-haiku-test') {
                throw new Error('title query should use the requested Haiku model');
              }
              if (!Array.isArray(options.tools) || options.tools.length !== 0) {
                throw new Error('title query should disable built-in tools');
              }
              if (options.persistSession !== false) {
                throw new Error('title query should not persist Claude history');
              }
              if (options.env.CLAUDE_AGENT_SDK_CLIENT_APP !== 'ccem-desktop') {
                throw new Error('title query should use the desktop SDK client app');
              }
              return {
                close() {},
                async *[Symbol.asyncIterator]() {
                  yield {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: '标题：AI 生成会话标题。' }] },
                  };
                  yield { type: 'result', subtype: 'success', result: 'done' };
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

test('title_query uses Claude Agent SDK query with Haiku model and no tools', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill();
  });

  const { outputs, stderrRef } = collectHelperOutput(helper);
  helper.stdin.write(`${JSON.stringify({
    type: 'title_query',
    title_input: '从工作间发起的会话生成标题',
    working_dir: process.cwd(),
    env_vars: {
      ANTHROPIC_AUTH_TOKEN: 'test-token',
      ANTHROPIC_MODEL: 'claude-haiku-test',
    },
    model: 'claude-haiku-test',
  })}\n`);

  const result = await waitForOutput(
    outputs,
    (output) => output.type === 'title_result',
    stderrRef,
    'title query result',
  );

  assert.equal(result.title, '标题：AI 生成会话标题。');
});
