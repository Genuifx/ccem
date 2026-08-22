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

async function buildHelperWithRouterProbe() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-route-init-test-'));
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
                  const routeEntry = options.hooks.PreToolUse.find((entry) => entry.matcher === 'Agent');
                  const routeResult = routeEntry ? await routeEntry.hooks[0]({
                      hook_event_name: 'PreToolUse',
                      tool_name: 'Agent',
                      tool_input: {
                        description: 'Probe routing',
                        subagent_type: 'Explore',
                        prompt: '<CCEM-ROUTE>ccem:glm</CCEM-ROUTE>\\nProbe.',
                      },
                      tool_use_id: 'tool-route-probe',
                    }) : null;
                  process.stdout.write(JSON.stringify({
                    type: 'router_probe',
                    hookMatchers: options.hooks.PreToolUse.map((entry) => entry.matcher ?? null),
                    routedPrompt: routeResult?.hookSpecificOutput?.updatedInput?.prompt ?? null,
                    env: {
                      subagentModel: options.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
                      backgroundModel: options.env.ANTHROPIC_SMALL_FAST_MODEL ?? null,
                      noProxy: options.env.NO_PROXY ?? null,
                      lowerNoProxy: options.env.no_proxy ?? null,
                      nonceLeaked: Object.values(options.env).includes('private_nonce'),
                    },
                    systemPrompt: options.systemPrompt ?? null,
                  }) + '\\n');
                  yield { type: 'result', subtype: 'success', result: 'done', session_id: 'mock-session' };
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
  let stderr = '';
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
  helper.stderr.on('data', (chunk) => { stderr += chunk; });

  return { outputs, getStderr: () => stderr };
}

function waitForOutput(outputs, predicate, getStderr) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = outputs.find(predicate);
      if (match) return resolve(match);
      if (Date.now() - startedAt > 2_000) {
        return reject(new Error(`Timed out. stdout=${JSON.stringify(outputs)} stderr=${getStderr()}`));
      }
      setTimeout(check, 20);
    };
    check();
  });
}

test('consumes the private router init payload in query options', async (t) => {
  const helperPath = await buildHelperWithRouterProbe();
  const helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGTERM'));
  const { outputs, getStderr } = collectHelperOutput(helper);

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'plan',
    working_dir: os.tmpdir(),
    env_vars: {
      CLAUDE_CODE_SUBAGENT_MODEL: 'must-be-removed',
      ANTHROPIC_SMALL_FAST_MODEL: 'must-be-replaced',
      NO_PROXY: 'internal.example',
    },
    router: {
      routeTagNonce: 'private_nonce',
      dynamicRouting: true,
      menu: 'Use only these explicit route targets: glm, official.',
    },
    initial_prompt: 'probe the routed query',
  })}\n`);

  const probe = await waitForOutput(outputs, (output) => output.type === 'router_probe', getStderr);

  assert.deepEqual(probe.hookMatchers, [null, 'Agent']);
  assert.equal(
    probe.routedPrompt,
    '<CCEM-ROUTE nonce="private_nonce">ccem:glm</CCEM-ROUTE>\nProbe.',
  );
  assert.equal(probe.env.subagentModel, null);
  assert.equal(probe.env.backgroundModel, 'ccem-route:background');
  assert.match(probe.env.noProxy, /127\.0\.0\.1,localhost,::1/);
  assert.equal(probe.env.lowerNoProxy, '127.0.0.1,localhost,::1');
  assert.equal(probe.env.nonceLeaked, false);
  assert.deepEqual(probe.systemPrompt, {
    type: 'preset',
    preset: 'claude_code',
    append: 'Use only these explicit route targets: glm, official.',
  });
});

test('leaves direct init query options unchanged', async (t) => {
  const helperPath = await buildHelperWithRouterProbe();
  const helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGTERM'));
  const { outputs, getStderr } = collectHelperOutput(helper);

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'plan',
    working_dir: os.tmpdir(),
    env_vars: {
      CLAUDE_CODE_SUBAGENT_MODEL: 'direct-subagent-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'direct-background-model',
      NO_PROXY: 'internal.example',
    },
    initial_prompt: 'probe the direct query',
  })}\n`);

  const probe = await waitForOutput(outputs, (output) => output.type === 'router_probe', getStderr);

  assert.deepEqual(probe.hookMatchers, [null]);
  assert.equal(probe.routedPrompt, null);
  assert.equal(probe.env.subagentModel, 'direct-subagent-model');
  assert.equal(probe.env.backgroundModel, 'direct-background-model');
  assert.equal(probe.env.noProxy, 'internal.example');
  assert.equal(probe.env.lowerNoProxy, null);
  assert.equal(probe.systemPrompt, null);
});

test('accepts the Rust router payload shape when the optional menu is omitted', async (t) => {
  const helperPath = await buildHelperWithRouterProbe();
  const helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGTERM'));
  const { outputs, getStderr } = collectHelperOutput(helper);

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'plan',
    working_dir: os.tmpdir(),
    env_vars: {
      CLAUDE_CODE_SUBAGENT_MODEL: 'must-be-removed',
      ANTHROPIC_SMALL_FAST_MODEL: 'must-be-replaced',
    },
    router: {
      routeTagNonce: 'private_nonce',
      dynamicRouting: false,
    },
    initial_prompt: 'probe a routed query without a menu',
  })}\n`);

  const probe = await waitForOutput(outputs, (output) => output.type === 'router_probe', getStderr);

  assert.deepEqual(probe.hookMatchers, [null, 'Agent']);
  assert.equal(
    probe.routedPrompt,
    '<CCEM-ROUTE nonce="private_nonce">ccem:glm</CCEM-ROUTE>\nProbe.',
  );
  assert.equal(probe.env.subagentModel, null);
  assert.equal(probe.env.backgroundModel, 'ccem-route:background');
  assert.equal(probe.env.nonceLeaked, false);
  assert.equal(probe.systemPrompt, null);
});
