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

const MOCK_USAGE_PAYLOAD = {
  session: {
    total_cost_usd: 0.123,
    total_api_duration_ms: 500,
    total_duration_ms: 800,
    total_lines_added: 10,
    total_lines_removed: 2,
    model_usage: {
      'claude-sonnet-4-5-test': {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 4000,
        cacheCreationInputTokens: 800,
        webSearchRequests: 0,
        costUSD: 0.1,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
      'claude-haiku-test': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.01,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    },
  },
  subscription_type: 'pro',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 12.5, resets_at: '2026-08-15T12:00:00Z' },
    seven_day: { utilization: 30, resets_at: null },
  },
};

const MOCK_CONTEXT_USAGE_PAYLOAD = {
  totalTokens: 45000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 22.5,
  autoCompactThreshold: 180000,
  isAutoCompactEnabled: true,
  model: 'claude-sonnet-4-5-test',
  categories: [
    { name: 'messages', tokens: 40000 },
    { name: 'tools', tokens: 5000 },
  ],
};

async function buildHelperWithMockClaudeSdk({ usageBehavior }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-usage-query-test-'));
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

            export function query({ prompt, options }) {
              if (!options.env || options.env.CLAUDE_AGENT_SDK_CLIENT_APP !== 'ccem-desktop') {
                throw new Error('SDK query should use the desktop client app env');
              }
              const behavior = ${JSON.stringify(usageBehavior)};
              return {
                close() {},
                interrupt() { return Promise.resolve(); },
                setPermissionMode() { return Promise.resolve(); },
                getContextUsage() { return Promise.resolve(${JSON.stringify(MOCK_CONTEXT_USAGE_PAYLOAD)}); },
                usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
                  if (behavior === 'throw') {
                    return Promise.reject(new Error('usage API exploded'));
                  }
                  return Promise.resolve(${JSON.stringify(MOCK_USAGE_PAYLOAD)});
                },
                async *[Symbol.asyncIterator]() {
                  while (true) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
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

function waitForOutput(outputs, predicate, stderrRef, description, timeoutMs = 3_000) {
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

async function spawnInitializedClaudeHelper(helperPath) {
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const { outputs, stderrRef } = collectHelperOutput(helper);

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'test-env',
    perm_mode: 'default',
    working_dir: process.cwd(),
    env_vars: {
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5-test',
    },
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status' && output.status === 'ready',
    stderrRef,
    'helper ready status',
  );

  return { helper, outputs, stderrRef };
}

test('usage_query actively emits session_usage with cache tokens and rate limits', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({ usageBehavior: 'ok' });
  const { helper, outputs, stderrRef } = await spawnInitializedClaudeHelper(helperPath);

  t.after(() => {
    helper.kill();
  });

  helper.stdin.write('{"type":"usage_query"}\n');

  const usageEvent = await waitForOutput(
    outputs,
    (output) => output.type === 'event' && output.payload?.type === 'session_usage',
    stderrRef,
    'session_usage event',
  );
  const payload = usageEvent.payload;

  assert.equal(payload.provider, 'claude');
  assert.equal(payload.input_tokens, 1100);
  assert.equal(payload.output_tokens, 250);
  assert.equal(payload.cache_read_tokens, 4000);
  assert.equal(payload.cache_creation_tokens, 800);
  assert.equal(payload.cost_usd, 0.123);
  assert.equal(payload.subscription_type, 'pro');
  assert.equal(payload.rate_limits_available, true);
  assert.deepEqual(payload.rate_limits.five_hour, { utilization: 12.5, resets_at: '2026-08-15T12:00:00Z' });

  assert.equal(payload.model_usage.length, 2);
  assert.deepEqual(payload.model_usage[0], {
    model: 'claude-sonnet-4-5-test',
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_tokens: 4000,
    cache_creation_tokens: 800,
    cost_usd: 0.1,
  });

  const contextEvent = await waitForOutput(
    outputs,
    (output) => output.type === 'event' && output.payload?.type === 'context_usage',
    stderrRef,
    'context_usage event',
  );
  assert.equal(contextEvent.payload.used_tokens, 45000);
  assert.equal(contextEvent.payload.max_tokens, 200000);
  assert.equal(contextEvent.payload.model, 'claude-sonnet-4-5-test');
});

test('usage_query degrades to a lifecycle notice when the SDK usage API fails', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({ usageBehavior: 'throw' });
  const { helper, outputs, stderrRef } = await spawnInitializedClaudeHelper(helperPath);

  t.after(() => {
    helper.kill();
  });

  helper.stdin.write('{"type":"usage_query"}\n');

  const failureEvent = await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload?.stage === 'usage_unavailable',
    stderrRef,
    'usage_unavailable lifecycle event',
  );
  assert.match(failureEvent.payload.detail, /usage API exploded/);

  assert.equal(
    outputs.some((output) => output.type === 'event' && output.payload?.type === 'session_usage'),
    false,
    'no session_usage event should be emitted when the SDK API fails',
  );
  assert.equal(
    outputs.some((output) => output.type === 'status' && /Usage query failed/.test(output.detail ?? '')),
    false,
    'a failed usage query must not emit Status (it would flip the session state machine)',
  );
});

test('usage_query is a silent no-op for codex sessions', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({ usageBehavior: 'ok' });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill();
  });

  const { outputs, stderrRef } = collectHelperOutput(helper);
  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'codex',
    env_name: 'test-env',
    perm_mode: 'default',
    working_dir: process.cwd(),
    env_vars: { OPENAI_API_KEY: 'test-key' },
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status' && output.status === 'ready',
    stderrRef,
    'helper ready status',
  );

  helper.stdin.write('{"type":"usage_query"}\n');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(
    outputs.some((output) => output.type === 'event'
      && (output.payload?.type === 'session_usage' || output.payload?.type === 'usage_unavailable')),
    false,
    'codex sessions should not emit SDK usage events',
  );
});
