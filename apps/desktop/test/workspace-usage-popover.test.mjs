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
        import { ContextCompositionView } from '@/components/workspace/SessionUsagePopover';

        export function render(usage, provider, onRefresh) {
          return renderToStaticMarkup(
            React.createElement(LocaleProvider, null,
              React.createElement(SessionUsagePopoverContent, { usage, provider, onRefresh })
            )
          );
        }

        export function renderComposition(context) {
          return renderToStaticMarkup(
            React.createElement(LocaleProvider, null,
              React.createElement(ContextCompositionView, { context })
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
  assert.match(html, /2 次请求/);
  assert.doesNotMatch(html, /×2/);
  assert.match(html, /general-purpose · GLM-5\.3/);
  // Unknown semantics: unreported + interrupted counted, not zero-filled.
  assert.match(html, /未报告用量的请求/);
  assert.match(html, /中断的请求/);
  // No conservation/reconciliation language anywhere.
  assert.doesNotMatch(html, /差额|守恒|合计=|总计=/);
  // Independence footnote present.
  assert.match(html, /不做相加或对账/);
});

// --- REQ-0028: context composition secondary view ---

/** Real production shape (observed `context_usage` event): used categories
 * sum to used_tokens exactly; all categories incl. Free space sum to
 * max_tokens exactly. */
function claudeContextFixture(categories) {
  return {
    provider: 'claude',
    usedTokens: categories
      .filter((c) => c.name !== 'Free space')
      .reduce((sum, c) => sum + c.tokens, 0),
    maxTokens: categories.reduce((sum, c) => sum + c.tokens, 0),
    rawMaxTokens: categories.reduce((sum, c) => sum + c.tokens, 0),
    percentage: 56.8,
    autoCompactThreshold: 967000,
    isAutoCompactEnabled: true,
    model: 'claude-sonnet-4-5-test',
    categories,
  };
}

const REAL_CLAUDE_CATEGORIES = [
  { name: 'System prompt', tokens: 738 },
  { name: 'System tools', tokens: 11911 },
  { name: 'MCP tools', tokens: 12031 },
  { name: 'Custom agents', tokens: 308 },
  { name: 'Memory files', tokens: 2065 },
  { name: 'Skills', tokens: 7311 },
  { name: 'Messages', tokens: 533640 },
  { name: 'Free space', tokens: 431996 },
];

test('usage panel renders the usage/composition view toggle when context exists', async () => {
  const { render } = await importSessionUsagePopoverRenderer();
  const html = render(fixtureUsage());

  assert.match(html, /aria-pressed="true"[^>]*>用量</);
  assert.match(html, /aria-pressed="false"[^>]*>组成</);
});

test('usage panel hides the view toggle without context data', async () => {
  const { render } = await importSessionUsagePopoverRenderer();
  const usage = {
    totalInputTokens: 100,
    totalOutputTokens: 40,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    estimatedCostUsd: null,
    turnCount: 1,
    context: null,
    sessionUsage: null,
  };
  const html = render(usage);

  assert.doesNotMatch(html, /组成/);
  assert.doesNotMatch(html, /aria-pressed/);
});

test('composition view renders per-category tokens and window shares (real event shape)', async () => {
  const { renderComposition } = await importSessionUsagePopoverRenderer();
  const html = renderComposition(claudeContextFixture(REAL_CLAUDE_CATEGORIES));

  assert.match(html, /上下文组成/);
  // Overall line shares the usage view idiom (lowercase compact tokens).
  assert.match(html, /已用 568k token，共 1.0m/);
  // Localized known category labels.
  assert.match(html, /系统提示词/);
  assert.match(html, /MCP 工具/);
  assert.match(html, /自定义 agents/);
  assert.match(html, /记忆文件/);
  assert.match(html, /技能/);
  assert.match(html, /历史消息/);
  // Token counts (compact format) and 1-decimal window shares.
  assert.match(html, />738</);
  assert.match(html, /0\.1%/); // System prompt 738/1000000
  assert.match(html, />534K</);
  assert.match(html, /53\.4%/); // Messages 533640/1000000
  // Free space: muted remainder row with its own share.
  assert.match(html, /剩余空间/);
  assert.match(html, />432K</);
  assert.match(html, /43\.2%/);
  // Stacked bar segments use the chart token palette; free space is muted.
  assert.match(html, /bg-chart-1/);
  assert.match(html, /bg-chart-2/);
  assert.match(html, /bg-chart-6/);
  assert.match(html, /bg-muted"/);
  // Estimate footnote (invisible boundary: upstream estimate basis).
  assert.match(html, /上游估算/);
});

test('composition view renders unknown category names verbatim', async () => {
  const { renderComposition } = await importSessionUsagePopoverRenderer();
  const html = renderComposition(claudeContextFixture([
    { name: 'Future Category', tokens: 1000 },
    { name: 'Free space', tokens: 99000 },
  ]));

  assert.match(html, /Future Category/);
});

test('composition view renders an empty state without categories', async () => {
  const { renderComposition } = await importSessionUsagePopoverRenderer();
  const html = renderComposition(claudeContextFixture([]));

  assert.match(html, /上下文组成/);
  assert.match(html, /暂未提供上下文组成数据/);
  assert.doesNotMatch(html, /bg-chart-1/);
});

test('composition view handles codex input/output categories', async () => {
  const { renderComposition } = await importSessionUsagePopoverRenderer();
  const context = {
    provider: 'codex',
    usedTokens: 192401,
    maxTokens: 258400,
    rawMaxTokens: 258400,
    percentage: 74.5,
    autoCompactThreshold: null,
    isAutoCompactEnabled: true,
    model: 'codex',
    categories: [
      { name: 'input', tokens: 192240 },
      { name: 'output', tokens: 161 },
    ],
  };
  const html = renderComposition(context);

  assert.match(html, /输入/);
  assert.match(html, /输出/);
  assert.match(html, />192K</);
  assert.match(html, /74\.4%/); // 192240/258400
  // No free-space row: codex does not report one (gap stays on the track).
  assert.doesNotMatch(html, /剩余空间/);
});
