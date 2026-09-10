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
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  for (const filename of INDEX_EXTENSIONS) {
    const candidate = path.join(basePath, filename);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

const desktopAliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = await resolveSourcePath(args.path);
      if (!resolved) {
        return { errors: [{ text: `Could not resolve ${args.path}` }] };
      }
      return { path: resolved };
    });
  },
};

async function importUsageIndicatorRenderer() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-usage-indicator-'));
  const outputPath = path.join(tempDir, 'usage-indicator-renderer.cjs');
  await build({
    stdin: {
      contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { LocaleProvider } from '@/locales';
        import { ContextWindowIndicator } from '@/components/workspace/ContextWindowIndicator';

        export const EMPTY_USAGE = {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          estimatedCostUsd: null,
          turnCount: 0,
          context: null,
          sessionUsage: null,
          routedLedger: null,
        };

        export function renderIndicator(usage) {
          return renderToStaticMarkup(
            React.createElement(
              LocaleProvider,
              null,
              React.createElement(ContextWindowIndicator, {
                usage,
                provider: 'claude',
                onRefreshUsage: () => {},
              }),
            ),
          );
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'usage-indicator-renderer.tsx',
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

test('composer usage ring renders for sessions without any usage events', async () => {
  const { EMPTY_USAGE, renderIndicator } = await importUsageIndicatorRenderer();

  // Regression (REQ-0010): a session whose events carry no token_usage /
  // context_usage / session_usage payload yet (fresh session, events still
  // replaying, provider without context events) must still show the usage
  // entry point in the composer instead of hiding it entirely.
  const html = renderIndicator(EMPTY_USAGE);

  assert.match(html, /aria-label="会话用量"/);
  // Neutral placeholder ring (no context data), not the conic-gradient fill.
  assert.match(html, /border-muted-foreground\/55/);
  assert.doesNotMatch(html, /conic-gradient/);
});

test('composer usage ring shows the context fill once context data exists', async () => {
  const { renderIndicator } = await importUsageIndicatorRenderer();

  const html = renderIndicator({
    totalInputTokens: 1200,
    totalOutputTokens: 340,
    totalCacheReadTokens: 8000,
    totalCacheCreationTokens: 500,
    estimatedCostUsd: 0.42,
    turnCount: 3,
    context: {
      provider: 'claude',
      usedTokens: 42000,
      maxTokens: 200000,
      rawMaxTokens: null,
      percentage: 21,
      autoCompactThreshold: null,
      isAutoCompactEnabled: true,
      model: 'claude-sonnet-4',
      categories: [],
    },
    sessionUsage: null,
    routedLedger: null,
  });

  assert.match(html, /aria-label="会话用量"/);
  assert.match(html, /conic-gradient/);
});

test('composer usage indicator keeps no data-gated early return', async () => {
  const component = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'ContextWindowIndicator.tsx'),
    'utf8',
  );

  // The old gate hid the whole entry point when no usage event had arrived.
  assert.doesNotMatch(component, /return null;\s*\n\s*const hasContext/);
  assert.doesNotMatch(component, /turnCount === 0 && !usage\.context && !usage\.sessionUsage/);
});
