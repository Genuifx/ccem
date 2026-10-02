import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function buildHelperWithMockClaudeSdk(entryPoint = 'index.ts') {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-title-query-test-'));
  const outfile = path.join(tempDir, 'native-runtime-helper.mjs');

  await build({
    ...(entryPoint === 'index.ts' ? {
      entryPoints: [path.join(packageDir, 'src', entryPoint)],
    } : {
      stdin: {
        contents: "export * from './workspaceTitleQuery'; export { titleQueryStats } from '@anthropic-ai/claude-agent-sdk';",
        resolveDir: path.join(packageDir, 'src'),
      },
    }),
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

            let attempts = 0;
            let closes = 0;
            export function titleQueryStats() { return { attempts, closes }; }
            export function query({ prompt, options }) {
              attempts++;
              if (!options.systemPrompt.includes('ProjectTree')) {
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
              if (options.settingSources.length !== 0 || options.thinking.type !== 'disabled') {
                throw new Error('title query must not load project settings or think');
              }
              if (options.cwd !== process.cwd() || options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS !== '256') {
                throw new Error('title query must preserve project context and bound output');
              }
              if (options.env.CLAUDE_AGENT_SDK_CLIENT_APP !== 'ccem-desktop') {
                throw new Error('title query should use the desktop SDK client app');
              }
              if (prompt.includes('permanent')) throw new Error('401 Unauthorized');
              if (prompt.includes('transient') && attempts === 1) throw new Error('503 overloaded');
              return {
                close() { closes++; },
                async *[Symbol.asyncIterator]() {
                  if (prompt.includes('hang')) await new Promise(() => {});
                  if (prompt.includes('empty')) {
                    yield { type: 'result', subtype: 'success', result: '' };
                    return;
                  }
                  if (prompt.includes('result-only')) {
                    yield { type: 'result', subtype: 'success', result: '结果帧中的标题' };
                    return;
                  }
                  if (prompt.includes('result-never-ends')) {
                    yield { type: 'result', subtype: 'success', result: '完成后的标题' };
                    await new Promise(() => {});
                  }
                  if (prompt.includes('result-failure') && attempts === 1) {
                    yield { type: 'result', subtype: 'error_during_execution', errors: ['503 overloaded'] };
                    return;
                  }
                  yield {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text: '标题：AI 生成会话标题。' }] },
                  };
                  yield { type: 'result', subtype: 'success', result: '标题：AI 生成会话标题。' };
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

async function titleQueryModule(t) {
  const modulePath = await buildHelperWithMockClaudeSdk('workspaceTitleQuery.ts');
  t.after(() => fs.rm(path.dirname(modulePath), { recursive: true, force: true }));
  return import(pathToFileURL(modulePath).href);
}

function titleCommand(title_input) {
  return {
    title_input,
    working_dir: process.cwd(),
    env_vars: { ANTHROPIC_AUTH_TOKEN: 'test-token', ANTHROPIC_MODEL: 'opus' },
    model: 'claude-haiku-test',
  };
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
    return fs.rm(path.dirname(helperPath), { recursive: true, force: true });
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

test('title_query reports an SDK auth failure without waiting for helper exit', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk();
  const helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { helper.kill(); return fs.rm(path.dirname(helperPath), { recursive: true, force: true }); });
  const { outputs, stderrRef } = collectHelperOutput(helper);
  helper.stdin.write(`${JSON.stringify({ type: 'title_query', ...titleCommand('permanent') })}\n`);
  const result = await waitForOutput(outputs, (output) => output.type === 'status' && output.status === 'error', stderrRef, 'terminal title error');
  assert.match(result.detail, /401 Unauthorized/);
  assert.equal(helper.exitCode, null);
});

test('title query retries a transient provider failure once and returns a title', async (t) => {
  const { generateWorkspaceTitle, titleQueryStats } = await titleQueryModule(t);
  assert.equal(await generateWorkspaceTitle(titleCommand('transient')), '标题：AI 生成会话标题。');
  assert.deepEqual(titleQueryStats(), { attempts: 2, closes: 1 });
});

test('title query accepts a successful result without an assistant message', async (t) => {
  const { generateWorkspaceTitle, titleQueryStats } = await titleQueryModule(t);
  assert.equal(await generateWorkspaceTitle(titleCommand('result-only')), '结果帧中的标题');
  assert.deepEqual(titleQueryStats(), { attempts: 1, closes: 1 });
});

test('title query bounds an iterator that ignores close and never yields', async (t) => {
  const { generateWorkspaceTitle, titleQueryStats } = await titleQueryModule(t);
  const startedAt = Date.now();
  await assert.rejects(generateWorkspaceTitle(titleCommand('hang'), 20), /timed out after 20ms/);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual(titleQueryStats(), { attempts: 2, closes: 2 });
});

test('title query rejects repeated empty output and preserves the fallback path', async (t) => {
  const { generateWorkspaceTitle, titleQueryStats } = await titleQueryModule(t);
  await assert.rejects(generateWorkspaceTitle(titleCommand('empty')), /empty title/);
  assert.deepEqual(titleQueryStats(), { attempts: 2, closes: 2 });
});

test('title query does not retry permanent auth failures', async (t) => {
  const { generateWorkspaceTitle, titleQueryStats } = await titleQueryModule(t);
  await assert.rejects(generateWorkspaceTitle(titleCommand('permanent')), /401 Unauthorized/);
  assert.deepEqual(titleQueryStats(), { attempts: 1, closes: 0 });
});

test('title query settles immediately at a successful result even if the iterator stays open', async (t) => {
  const { generateWorkspaceTitle, titleQueryStats } = await titleQueryModule(t);
  assert.equal(await generateWorkspaceTitle(titleCommand('result-never-ends'), 20), '完成后的标题');
  assert.deepEqual(titleQueryStats(), { attempts: 1, closes: 1 });
});

test('title query retries provider errors carried in result frames', async (t) => {
  const { generateWorkspaceTitle, titleQueryStats } = await titleQueryModule(t);
  assert.equal(await generateWorkspaceTitle(titleCommand('result-failure')), '标题：AI 生成会话标题。');
  assert.deepEqual(titleQueryStats(), { attempts: 2, closes: 2 });
});
