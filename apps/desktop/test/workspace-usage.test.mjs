import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWorkspaceUsage() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceUsage.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-usage-test-'));
  const outputPath = path.join(tempDir, 'workspaceUsage.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function event(seq, payload) {
  return {
    runtime_id: 'runtime-1',
    seq,
    occurred_at: `2026-05-12T00:00:${String(seq).padStart(2, '0')}.000Z`,
    payload,
  };
}

test('uses the latest context_usage snapshot without requiring token events', async () => {
  const { computeSessionUsage } = await importWorkspaceUsage();

  const usage = computeSessionUsage([
    event(1, {
      type: 'context_usage',
      provider: 'codex',
      used_tokens: 167_000,
      max_tokens: 258_400,
      raw_max_tokens: 258_400,
      percentage: 64.6,
      auto_compact_threshold: null,
      is_auto_compact_enabled: true,
      model: 'gpt-5.5-codex',
      categories: [],
    }),
  ]);

  assert.equal(usage.turnCount, 0);
  assert.equal(usage.context.provider, 'codex');
  assert.equal(usage.context.usedTokens, 167_000);
  assert.equal(usage.context.maxTokens, 258_400);
  assert.equal(Math.round(usage.context.percentage), 65);
});

test('does not double-count Claude per-message usage when turn total exists', async () => {
  const { computeSessionUsage } = await importWorkspaceUsage();

  const usage = computeSessionUsage([
    event(1, {
      type: 'token_usage',
      provider: 'claude',
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_creation_tokens: 1,
    }),
    event(2, {
      type: 'token_usage',
      provider: 'claude',
      input_tokens: 30,
      output_tokens: 7,
      cache_read_tokens: 4,
      cache_creation_tokens: 3,
      total_cost_usd: 0.0123,
      scope: 'turn_total',
    }),
  ]);

  assert.equal(usage.turnCount, 1);
  assert.equal(usage.totalInputTokens, 30);
  assert.equal(usage.totalOutputTokens, 7);
  assert.equal(usage.totalCacheReadTokens, 4);
  assert.equal(usage.totalCacheCreationTokens, 3);
  assert.equal(usage.estimatedCostUsd, 0.0123);
});

test('turn_total cost is session-cumulative: latest event wins instead of summing', async () => {
  const { computeSessionUsage } = await importWorkspaceUsage();

  const usage = computeSessionUsage([
    event(1, {
      type: 'token_usage',
      provider: 'claude',
      input_tokens: 30,
      output_tokens: 7,
      cache_read_tokens: 4,
      cache_creation_tokens: 3,
      total_cost_usd: 0.0123,
      scope: 'turn_total',
    }),
    event(2, {
      type: 'token_usage',
      provider: 'claude',
      input_tokens: 20,
      output_tokens: 6,
      cache_read_tokens: 5,
      cache_creation_tokens: 1,
      total_cost_usd: 0.02,
      scope: 'turn_total',
    }),
  ]);

  assert.equal(usage.estimatedCostUsd, 0.02);
});

test('takes the latest session_usage snapshot and keeps the empty state otherwise', async () => {
  const { computeSessionUsage } = await importWorkspaceUsage();

  const usage = computeSessionUsage([
    event(1, {
      type: 'session_usage',
      provider: 'claude',
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 300,
      cache_creation_tokens: 80,
      cost_usd: 0.0042,
      model_usage: [
        {
          model: 'claude-sonnet-4-5-test',
          input_tokens: 100,
          output_tokens: 10,
          cache_read_tokens: 300,
          cache_creation_tokens: 80,
          cost_usd: 0.0042,
        },
      ],
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 12.5, resets_at: '2026-08-15T12:00:00Z' },
        seven_day: null,
      },
    }),
    event(2, {
      type: 'session_usage',
      provider: 'claude',
      input_tokens: 150,
      output_tokens: 15,
      cache_read_tokens: 400,
      cache_creation_tokens: 90,
      cost_usd: null,
      model_usage: [],
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    }),
  ]);

  assert.equal(usage.sessionUsage.inputTokens, 150);
  assert.equal(usage.sessionUsage.cacheReadTokens, 400);
  assert.equal(usage.sessionUsage.costUsd, null);
  assert.equal(usage.sessionUsage.modelUsage.length, 0);
  assert.equal(usage.sessionUsage.rateLimitsAvailable, false);
  assert.equal(usage.sessionUsage.rateLimits, null);

  const empty = computeSessionUsage([]);
  assert.equal(empty.turnCount, 0);
  assert.equal(empty.context, null);
  assert.equal(empty.sessionUsage, null);
});

test('routes a request ledger: dedup by request_id, unattributed kept, never zero-filled', async () => {
  const { computeSessionUsage } = await importWorkspaceUsage();

  const usage = computeSessionUsage([
    event(1, {
      type: 'routed_request',
      provider: 'claude',
      request_id: 'req-1',
      target_env: 'GLM-5.3',
      model: 'glm-5.3',
      logical_key: 'main',
      status: 200,
      complete: true,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
    }),
    event(2, {
      type: 'routed_request',
      provider: 'claude',
      request_id: 'req-2',
      target_env: 'DeepSeek-V4-Flash',
      model: 'deepseek-v4-flash',
      logical_key: 'subagent:Explore',
      status: 200,
      complete: true,
      usage: { input_tokens: 500, output_tokens: 40, cache_read_tokens: 480, cache_creation_tokens: 0 },
    }),
    // Same request replayed (event bus replay / duplicate emission): must NOT double-count.
    event(3, {
      type: 'routed_request',
      provider: 'claude',
      request_id: 'req-2',
      target_env: 'DeepSeek-V4-Flash',
      model: 'deepseek-v4-flash',
      logical_key: 'subagent:Explore',
      status: 200,
      complete: true,
      usage: { input_tokens: 500, output_tokens: 40, cache_read_tokens: 480, cache_creation_tokens: 0 },
    }),
    // Usage-less request: counted as unattributed, never rendered as zeros.
    event(4, {
      type: 'routed_request',
      provider: 'claude',
      request_id: 'req-3',
      target_env: 'DeepSeek-V4-Flash',
      model: 'deepseek-v4-flash',
      logical_key: 'subagent:Explore',
      status: 200,
      complete: true,
      usage: null,
    }),
    // Interrupted stream with partial usage: row counts it, incomplete counter too.
    event(5, {
      type: 'routed_request',
      provider: 'claude',
      request_id: 'req-4',
      target_env: 'GLM-5.3',
      model: 'glm-5.3',
      logical_key: 'main',
      status: 200,
      complete: false,
      usage: { input_tokens: 300, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    }),
  ]);

  const ledger = usage.routedLedger;
  assert.ok(ledger, 'ledger must exist for routed sessions');
  assert.equal(ledger.unattributedCount, 1, 'usage-less requests are counted, not zero-filled');
  assert.equal(ledger.incompleteCount, 1);

  // Rows: Explore/DeepSeek (500+40, ONE request after dedup) and main/GLM
  // (100+20 plus the incomplete 300+0 both under main/GLM/glm-5.3).
  assert.equal(ledger.rows.length, 2);
  const explore = ledger.rows[0];
  assert.equal(explore.logicalKey, 'subagent:Explore');
  assert.equal(explore.env, 'DeepSeek-V4-Flash');
  assert.equal(explore.requestCount, 1, 'duplicate request_id must collapse');
  assert.equal(explore.inputTokens, 500);
  assert.equal(explore.cacheReadTokens, 480);
  const mainRow = ledger.rows[1];
  assert.equal(mainRow.logicalKey, 'main');
  assert.equal(mainRow.requestCount, 2);
  assert.equal(mainRow.inputTokens, 400);
});

test('non-routed sessions expose no ledger', async () => {
  const { computeSessionUsage } = await importWorkspaceUsage();
  const usage = computeSessionUsage([
    event(1, {
      type: 'token_usage',
      provider: 'claude',
      input_tokens: 5,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0.01,
      scope: 'turn_total',
    }),
  ]);
  assert.equal(usage.routedLedger, null);
});
