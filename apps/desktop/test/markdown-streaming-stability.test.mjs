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
      // Try the next extension.
    }
  }
  for (const filename of INDEX_EXTENSIONS) {
    const candidate = path.join(basePath, filename);
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next index extension.
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

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-markdown-streaming-'));
  const outputPath = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { MarkdownRenderer } from '@/components/history/MarkdownRenderer';
        import { LocaleProvider } from '@/locales';

        export function mount(container, initialProps) {
          const root = createRoot(container);
          const render = (props) => act(() => {
            root.render(
              React.createElement(
                LocaleProvider,
                null,
                React.createElement(MarkdownRenderer, props),
              ),
            );
          });
          render(initialProps);
          return {
            render,
            dispatch(element, type) {
              act(() => {
                element.dispatchEvent(new window.Event(type));
              });
            },
            unmount() { act(() => root.unmount()); },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'markdown-streaming-harness.tsx',
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

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const expose = (name, value) => Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  expose('window', dom.window);
  expose('document', dom.window.document);
  expose('navigator', dom.window.navigator);
  expose('HTMLElement', dom.window.HTMLElement);
  expose('Element', dom.window.Element);
  expose('Event', dom.window.Event);
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  return dom;
}

test('streaming appends keep existing image and code DOM identity (no subtree remount)', async () => {
  const dom = installDom();
  const { harness, tempDir } = await importHarness();
  const container = document.getElementById('root');
  const baseContent = [
    'Intro paragraph.',
    '',
    '![chart](https://example.com/chart.png)',
    '',
    '```ts',
    'const first = 1;',
    '```',
  ].join('\n');

  try {
    const mounted = harness.mount(container, { content: baseContent, codeTone: 'reading' });
    const imgBefore = container.querySelector('img');
    const codeBefore = container.querySelector('pre code');
    const paragraphBefore = container.querySelector('p');
    assert.ok(imgBefore, 'image rendered');
    assert.ok(codeBefore, 'code block rendered');

    // Streaming delta: text appended after the image/code, exactly how a
    // growing assistant message arrives.
    mounted.render({
      content: `${baseContent}\n\nFollow-up paragraph that keeps streaming.`,
      codeTone: 'reading',
    });

    assert.equal(container.querySelector('img'), imgBefore, 'img node identity preserved');
    assert.equal(container.querySelector('pre code'), codeBefore, 'code node identity preserved');
    assert.equal(container.querySelector('p'), paragraphBefore, 'first paragraph identity preserved');
    assert.match(container.textContent, /Follow-up paragraph/);

    // A second delta must also preserve identity.
    mounted.render({
      content: `${baseContent}\n\nFollow-up paragraph that keeps streaming. More text.`,
      codeTone: 'reading',
    });
    assert.equal(container.querySelector('img'), imgBefore, 'img identity preserved across deltas');
    assert.equal(container.querySelector('pre code'), codeBefore, 'code identity preserved across deltas');

    mounted.unmount();
  } finally {
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    stopEsbuild();
  }
});

test('markdown images reserve a stable placeholder until load and forward intrinsic size', async () => {
  const dom = installDom();
  const { harness, tempDir } = await importHarness();
  const container = document.getElementById('root');

  try {
    // Unknown intrinsic size: a fixed placeholder box is held until onLoad.
    const mounted = harness.mount(container, {
      content: '![shot](https://example.com/shot.png)',
      codeTone: 'reading',
    });
    const dispatch = mounted.dispatch;
    const button = container.querySelector('button[aria-label="shot"]');
    assert.ok(button, 'image affordance rendered');
    assert.match(button.className, /h-\[150px\]/, 'placeholder height reserved pre-load');
    assert.match(button.className, /w-\[min\(100%,320px\)\]/, 'placeholder width reserved pre-load');
    const img = button.querySelector('img');
    assert.match(img.className, /invisible/, 'image hidden inside the reserved box pre-load');

    dispatch(img, 'load');
    assert.doesNotMatch(button.className, /h-\[150px\]/, 'placeholder released after load');
    assert.doesNotMatch(img.className, /invisible/, 'image visible after load');

    // A failed load must also release the placeholder so layout can settle.
    mounted.render({
      content: '![broken](https://example.com/broken.png)',
      codeTone: 'reading',
    });
    const brokenButton = container.querySelector('button[aria-label="broken"]');
    const brokenImg = brokenButton.querySelector('img');
    assert.match(brokenButton.className, /h-\[150px\]/, 'placeholder held while loading');
    dispatch(brokenImg, 'error');
    assert.doesNotMatch(brokenButton.className, /h-\[150px\]/, 'placeholder released on error');

    mounted.unmount();
  } finally {
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    stopEsbuild();
  }
});
