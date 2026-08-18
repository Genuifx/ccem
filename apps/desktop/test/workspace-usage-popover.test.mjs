import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
const INDEX_EXTENSIONS = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.json'];

async function resolveSourcePath(importPath) {
  const basePath = path.join(desktopDir, 'src', importPath.slice(2));
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  for (const filename of INDEX_EXTENSIONS) {
    const candidate = path.join(basePath, filename);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const desktopAliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => ({
      path: await resolveSourcePath(args.path),
    }));
  },
};

async function importSessionUsagePopoverRenderer() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-usage-popover-test-'));
  const outputPath = path.join(tempDir, 'usage-popover-renderer.cjs');
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { LocaleProvider } from '@/locales';
        import { SessionUsagePopoverContent } from '@/components/workspace/SessionUsagePopover';

        export function render(usage, provider, onRefresh) {
          return renderToStaticMarkup(
            React.createElement(LocaleProvider, null,
              React.createElement(SessionUsagePopoverContent, { usage, provider, onRefresh })
            )
          );
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'usage-popover-renderer.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [desktopAliasPlugin],
    logLevel: 'silent',
  });
  return import(pathToFileURL(outputPath).href);
}

function fixtureUsage({ withSnapshot = true, derivedInput = 0 } = {}) {
  return {
    totalInputTokens: derivedInput,
    totalOutputTokens: 40,
    totalCacheReadTokens: 80,
    totalCacheCreationTokens: 12,
    estimatedCostUsd: 0.05,
    turnCount: 1,
    context: {
      provider: 'claude',
      usedTokens: 45000,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 22.5,
      autoCompactThreshold: 180000,
      isAutoCompactEnabled: true,
      model: 'claude-sonnet-4-5-test',
      categories: [],
    },
    sessionUsage: withSnapshot
      ? {
          provider: 'claude',
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 300,
          cacheCreationTokens: 80,
          costUsd: 0.0042,
          modelUsage: [
            {
              model: 'claude-sonnet-4-5-test',
              inputTokens: 100,
              outputTokens: 40,
              cacheReadTokens: 300,
              cacheCreationTokens: 80,
              costUsd: 0.0042,
            },
          ],
          subscriptionType: 'pro',
          rateLimitsAvailable: true,
          rateLimits: {
            fiveHour: { utilization: 12.5, resetsAt: '2026-08-15T12:00:00Z' },
            sevenDay: { utilization: 30, resetsAt: null },
          },
        }
      : null,
  };
}

test('renders SDK snapshot sections: totals, cache hit rate, models, rate limits', async () => {
  const { render } = await importSessionUsagePopoverRenderer();
  const html = render(fixtureUsage());

  assert.match(html, /会话用量/);
  assert.match(html, /上下文占用/);
  assert.match(html, /输入 tokens/);
  assert.match(html, /输出 tokens/);
  assert.match(html, /缓存读取/);
  assert.match(html, /缓存写入/);
  assert.match(html, /预估费用/);
  // Merge takes the max of the SDK snapshot (0.0042) and the latest
  // event-derived cumulative cost (0.05).
  assert.match(html, /\$0\.05/);
  assert.match(html, /75% 命中/); // 300 / (300 + 100)
  assert.match(html, /会话总用量（SDK）/);
  assert.match(html, /模型（SDK）/);
  assert.match(html, /claude-sonnet-4-5-test/);
  // Frozen contract: no sub-route section without router ledger data.
  assert.doesNotMatch(html, /子路由用量/);
  assert.match(html, /速率限制/);
  assert.match(html, /5 小时窗口/);
  assert.match(html, /7 天窗口/);
  assert.match(html, /13%/);
  assert.match(html, /30%/);
});

test('merges event-derived totals when they outpace the SDK snapshot', async () => {
  const { render } = await importSessionUsagePopoverRenderer();
  // Event-derived input (150) exceeds the snapshot (100) — panel shows 150.
  const html = render(fixtureUsage({ derivedInput: 150 }));
  assert.match(html, />150</);
});

test('falls back to event-derived totals without SDK snapshot sections', async () => {
  const { render } = await importSessionUsagePopoverRenderer();
  const html = render(fixtureUsage({ withSnapshot: false }));

  assert.match(html, /会话用量/);
  assert.match(html, /上下文占用/);
  assert.match(html, /缓存读取/);
  assert.doesNotMatch(html, /模型（SDK）/);
  assert.doesNotMatch(html, /速率限制/);
});

test('renders an empty state when no usage data exists at all', async () => {
  const { render } = await importSessionUsagePopoverRenderer();
  const html = render({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    estimatedCostUsd: null,
    turnCount: 0,
    context: null,
    sessionUsage: null,
  });

  assert.match(html, /暂无用量数据/);
});

test('renders the independent sub-route section next to SDK sections (frozen contract)', async () => {
  const { render } = await importSessionUsagePopoverRenderer();
  const usage = fixtureUsage();
  usage.routedLedger = {
    rows: [
      {
        logicalKey: 'subagent:Explore',
        env: 'DeepSeek-V4-Flash',
        model: 'deepseek-v4-flash',
        requestCount: 2,
        inputTokens: 28147,
        outputTokens: 114,
        cacheReadTokens: 27904,
        cacheCreationTokens: 0,
      },
      {
        logicalKey: 'subagent:general-purpose',
        env: 'GLM-5.3',
        model: 'glm-5.3',
        requestCount: 1,
        inputTokens: 300,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ],
    unattributedCount: 1,
    incompleteCount: 1,
  };
  const html = render(usage);

  // Two independent sections, clearly separated.
  assert.match(html, /会话总用量（SDK）/);
  assert.match(html, /模型（SDK）/);
  assert.match(html, /子路由用量（Router 观测）/);
  // Sub-route rows by agent identity -> env, with request counts.
  assert.match(html, /Explore · DeepSeek-V4-Flash/);
  assert.match(html, />28K</);
  assert.match(html, /×2/);
  assert.match(html, /general-purpose · GLM-5\.3/);
  // Unknown semantics: unreported + interrupted counted, not zero-filled.
  assert.match(html, /未报告用量的请求/);
  assert.match(html, /中断的请求/);
  // No conservation/reconciliation language anywhere.
  assert.doesNotMatch(html, /差额|守恒|合计=|总计=/);
  // Independence footnote present.
  assert.match(html, /不做相加或对账/);
});
