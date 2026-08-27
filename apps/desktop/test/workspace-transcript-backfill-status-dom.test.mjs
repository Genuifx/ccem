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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-backfill-status-test-'));
  const outputPath = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { WorkspaceTranscriptBackfillStatus } from '@/components/workspace/WorkspaceTranscriptBackfillStatus';

        export function mount(container, onRetry) {
          const root = createRoot(container);
          const render = (state) => act(() => {
            root.render(
              <>
                <p data-testid="visible-tail">latest visible message</p>
                <WorkspaceTranscriptBackfillStatus
                  state={state}
                  loadingMessage="Loading full transcript..."
                  errorMessage="Could not load the full transcript."
                  partialMessage="Some earlier transcript entries are unavailable."
                  retryLabel="Retry"
                  onRetry={onRetry}
                />
              </>,
            );
          });
          return {
            render,
            click(element) { act(() => element.click()); },
            unmount() { act(() => root.unmount()); },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'workspace-transcript-backfill-status-harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [desktopAliasPlugin],
    define: { 'process.env.NODE_ENV': '"test"' },
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
  expose('Node', dom.window.Node);
  expose('Element', dom.window.Element);
  expose('HTMLElement', dom.window.HTMLElement);
  expose('Event', dom.window.Event);
  expose('MouseEvent', dom.window.MouseEvent);
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  return dom;
}

test('backfill status stays singular, exposes failure, and retries without hiding the tail', async () => {
  const dom = installDom();
  const { harness, tempDir } = await importHarness();
  const container = document.getElementById('root');
  let retryCalls = 0;
  const mounted = harness.mount(container, () => { retryCalls += 1; });

  try {
    mounted.render('loading');
    assert.equal(container.querySelectorAll('[role="status"]').length, 1);
    assert.match(container.textContent, /Loading full transcript/);
    assert.equal(container.querySelector('[role="alert"]'), null);

    mounted.render('error');
    assert.equal(container.querySelectorAll('[role="alert"]').length, 1);
    assert.match(container.textContent, /Could not load the full transcript/);
    assert.match(container.querySelector('[data-testid="visible-tail"]').textContent, /latest visible/);
    mounted.click(container.querySelector('button'));
    assert.equal(retryCalls, 1);

    mounted.render('partial');
    assert.equal(container.querySelectorAll('[role="alert"]').length, 1);
    assert.match(container.textContent, /Some earlier transcript entries are unavailable/);
    assert.match(container.querySelector('[data-testid="visible-tail"]').textContent, /latest visible/);
    assert.equal(container.querySelector('.animate-spin'), null);
    mounted.click(container.querySelector('button'));
    assert.equal(retryCalls, 2);

    mounted.render('idle');
    assert.equal(container.querySelector('[role="status"], [role="alert"]'), null);
  } finally {
    mounted.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    stopEsbuild();
  }
});
