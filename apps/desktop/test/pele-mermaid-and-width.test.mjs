import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
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
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try next extension.
    }
  }
  for (const filename of INDEX_EXTENSIONS) {
    const candidate = path.join(basePath, filename);
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try next index candidate.
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

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'SVGElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'getComputedStyle',
  ]) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => setImmediate(() => this.port1.onmessage?.({ data })) };
    }
  };
  return dom;
}

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-pele-markdown-'));
  const outputPath = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { MarkdownRenderer } from '@/components/history/MarkdownRenderer';
        import { LocaleProvider } from '@/locales';

        export { act };
        export function mount(container, initialProps) {
          const root = createRoot(container);
          const render = async (props) => {
            await act(async () => {
              root.render(
                React.createElement(
                  LocaleProvider,
                  null,
                  React.createElement(
                    'div',
                    { className: 'workspace-msg-virtualized' },
                    React.createElement(MarkdownRenderer, props),
                  ),
                ),
              );
            });
          };
          return {
            render,
            unmount: async () => {
              await act(async () => {
                root.unmount();
              });
            },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'pele-markdown-harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [desktopAliasPlugin],
    define: {
      'process.env.NODE_ENV': '"test"',
      'import.meta.env.VITE_PERF_MODE': 'undefined',
    },
    logLevel: 'silent',
  });
  return { harness: await import(pathToFileURL(outputPath).href), tempDir };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test('workspace transcript columns align with composer max-w-5xl width without 760px clamps', async () => {
  const [historyDetail, nativeView, transcriptList, messageBubble, splitHistory, composer] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src/components/workspace/WorkspaceConversationDetail.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src/components/workspace/WorkspaceNativeSessionView.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src/components/workspace/WorkspaceTranscriptList.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src/components/workspace/WorkspaceMessageBubble.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src/components/workspace/WorkspaceSplitHistoryPane.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src/components/workspace/WorkspaceSessionComposer.tsx'), 'utf8'),
  ]);

  assert.match(composer, /max-w-5xl/, 'composer shell stays on max-w-5xl');
  assert.match(historyDetail, /data-workspace-transcript-column="true"[\s\S]*?max-w-5xl/);
  assert.match(nativeView, /data-workspace-transcript-column="true"[\s\S]*?max-w-5xl/);
  assert.doesNotMatch(historyDetail, /max-w-\[860px\]/);
  assert.doesNotMatch(nativeView, /max-w-\[960px\]/);
  assert.doesNotMatch(transcriptList, /max-w-\[760px\]/);
  assert.doesNotMatch(messageBubble, /max-w-\[760px\]/);
  assert.match(splitHistory, /<LazyConversationDetail\s+compact/);
});

test('MarkdownRenderer renders mermaid fences via Pele into SVG, supports preview/source toggle, and handles streaming fallback', async () => {
  const dom = installDom();
  const { harness, tempDir } = await importHarness();
  const container = document.getElementById('root');

  try {
    const mounted = harness.mount(container);

    // 1. Streaming incomplete mermaid starts in graceful source fallback without throwing.
    await mounted.render({
      content: '```mermaid\nflowch\n```',
      codeTone: 'reading',
    });
    const block = container.querySelector('[data-pele-mermaid="true"]');
    assert.ok(block, 'mermaid block mounted');
    assert.equal(block.getAttribute('data-pele-state'), 'pending');
    assert.match(block.textContent, /flowch/, 'raw source visible while streaming incomplete syntax');

    // 2. Completing the mermaid fence upgrades in place to a rendered Pele SVG.
    const validMarkdown = [
      '## 验证结果',
      '',
      '| 验证项 | 结果 |',
      '| --- | --- |',
      '| `pnpm test` | 全部通过 |',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[输入消息] --> B[Pele 引擎]',
      '  B --> C[主题 SVG]',
      '```',
    ].join('\n');

    await mounted.render({ content: validMarkdown, codeTone: 'reading' });
    await waitFor(() => container.querySelector('[data-pele-mermaid="true"]')?.getAttribute('data-pele-state') === 'ready');

    const readyBlock = container.querySelector('[data-pele-mermaid="true"]');
    assert.equal(readyBlock?.getAttribute('data-pele-state'), 'ready');
    assert.equal(readyBlock?.getAttribute('data-pele-type'), 'flowchart');

    const svg = readyBlock?.querySelector('[data-pele-canvas="true"] svg');
    assert.ok(svg, 'Pele rendered an inline SVG diagram');
    assert.match(svg.outerHTML, /输入消息/);
    assert.match(svg.outerHTML, /Pele 引擎/);

    // 3. Verify polished table structure (scrollable rounded container, align-top cells).
    const tableWrapper = container.querySelector('table')?.parentElement;
    assert.ok(tableWrapper?.className.includes('overflow-x-auto'), 'tables wrap in horizontally scrollable frame');
    assert.ok(container.querySelector('td')?.className.includes('align-top'), 'table cells top-aligned');

    // 4. Switching to Source mode shows raw mermaid code; switching back restores SVG.
    const sourceBtn = [...readyBlock.querySelectorAll('button')].find((b) => /源码|Source/.test(b.textContent || ''));
    const previewBtn = [...readyBlock.querySelectorAll('button')].find((b) => /图表|Diagram/.test(b.textContent || ''));
    assert.ok(sourceBtn && previewBtn, 'preview/source toggle buttons rendered');

    await harness.act(async () => {
      sourceBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(readyBlock.querySelector('[data-pele-canvas="true"]'), null, 'canvas unmounted in source view');
    assert.match(readyBlock.querySelector('pre code')?.textContent || '', /flowchart LR/);

    await harness.act(async () => {
      previewBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => Boolean(readyBlock.querySelector('[data-pele-canvas="true"] svg')));
    assert.ok(readyBlock.querySelector('[data-pele-canvas="true"] svg'), 'SVG re-rendered synchronously on preview return');

    // 5. Invalid mermaid syntax degrades cleanly to source fallback with error state.
    await mounted.render({
      content: '```mermaid\nflowchart LR\n  A --> --> -->\n```',
      codeTone: 'reading',
    });
    // Mount a fresh invalid block to verify error fallback without prior valid SVG.
    await mounted.render({ content: 'plain text', codeTone: 'reading' });
    await mounted.render({
      content: '```mermaid\nsequenceDiagram\n  :::broken:::\n```',
      codeTone: 'reading',
    });
    await waitFor(() => container.querySelector('[data-pele-mermaid="true"]')?.getAttribute('data-pele-state') === 'error');
    const erroredBlock = container.querySelector('[data-pele-mermaid="true"]');
    assert.equal(erroredBlock?.getAttribute('data-pele-state'), 'error');
    assert.match(erroredBlock?.querySelector('pre code')?.textContent || '', /:::broken:::/);

    await mounted.unmount();
  } finally {
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    stopEsbuild();
  }
});
