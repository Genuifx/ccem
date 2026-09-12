import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const desktopDir = path.resolve(import.meta.dirname, '..');

async function resolveDesktopSource(importPath) {
  const base = path.join(desktopDir, 'src', importPath.slice(2));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next source shape.
    }
  }
  return null;
}

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-attachment-summary-chip-'));
  const outfile = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { TooltipProvider } from '@/components/ui/tooltip';
        import { WorkspaceMessageBubble } from '@/components/workspace/WorkspaceMessageBubble';

        function settle() {
          return new Promise((resolve) => setTimeout(resolve, 0));
        }

        async function flushInteraction() {
          await act(async () => {
            await settle();
          });
          await act(async () => {
            await settle();
          });
        }

        export async function mount(container, message) {
          const root = createRoot(container);
          act(() => root.render(
            <TooltipProvider>
              <WorkspaceMessageBubble message={message} prevRole={null} />
            </TooltipProvider>
          ));
          await flushInteraction();
          return {
            async unmount() {
              act(() => root.unmount());
              await new Promise((resolve) => setImmediate(resolve));
            },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'workspace-attachment-summary-chip-harness.tsx',
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'desktop-alias-and-locale-stub',
      setup(builder) {
        builder.onResolve({ filter: /^@\/locales$/ }, () => ({
          path: 'locales',
          namespace: 'stub',
        }));
        builder.onLoad({ filter: /^locales$/, namespace: 'stub' }, () => ({
          loader: 'js',
          contents: `
            const labels = {
              'workspace.transcriptFilesAttached': '{count} files attached',
              'workspace.transcriptTextSnippetsAttached': '{count} text snippets',
            };
            export function useLocale() {
              return { t: (key) => labels[key] || key };
            }
          `,
        }));
        builder.onResolve({ filter: /^@\// }, async (args) => {
          const resolved = await resolveDesktopSource(args.path);
          return resolved
            ? { path: resolved }
            : { errors: [{ text: `Cannot resolve ${args.path}` }] };
        });
      },
    }],
    logLevel: 'silent',
  });
  return {
    harness: await import(pathToFileURL(outfile).href),
    tempDir,
  };
}

function installDom() {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'http://localhost/' },
  );
  const { window } = dom;
  const expose = (name, value) => Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });

  for (const name of [
    'Node',
    'NodeFilter',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLTextAreaElement',
    'HTMLButtonElement',
    'SVGElement',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'CustomEvent',
    'MutationObserver',
    'DOMRect',
  ]) {
    expose(name, window[name]);
  }
  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  expose('requestAnimationFrame', (callback) => setTimeout(() => callback(Date.now()), 0));
  expose('cancelAnimationFrame', clearTimeout);

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => {
          setImmediate(() => this.port1.onmessage?.({ data }));
        },
      };
    }
  }
  Object.defineProperty(window, 'PointerEvent', {
    configurable: true,
    value: window.MouseEvent,
  });
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserver,
  });
  Object.defineProperty(window, 'MessageChannel', {
    configurable: true,
    value: TestMessageChannel,
  });
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value() {},
  });
  Object.defineProperty(window.HTMLElement.prototype, 'hasPointerCapture', {
    configurable: true,
    value() { return false; },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value() {},
  });
  Object.defineProperty(window.HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true,
    value() {},
  });
  expose('PointerEvent', window.PointerEvent);
  expose('ResizeObserver', ResizeObserver);
  expose('MessageChannel', TestMessageChannel);

  return dom;
}

function userMessage(content) {
  return {
    msgType: 'user',
    uuid: 'attachment-summary-message',
    content,
    timestamp: Date.parse('2026-09-07T10:00:00.000Z'),
    segmentIndex: 0,
    isCompactBoundary: false,
  };
}

function chip(kind) {
  return document.querySelector(`[data-workspace-attachment-summary="${kind}"]`);
}

test('user bubble renders attachment summary lines as chips instead of plain text', {
  timeout: 20_000,
}, async (t) => {
  const dom = installDom();
  const { harness, tempDir } = await importHarness();
  const root = document.querySelector('#root');

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    dom.window.close();
    await stopEsbuild();
  });

  const { unmount } = await harness.mount(root, userMessage(
    'Please polish this copy\n\nFiles attached: 2\nText snippets attached: 1',
  ));
  t.after(() => unmount());

  const filesChip = chip('files');
  assert.ok(filesChip, 'expected a files attachment summary chip');
  assert.equal(filesChip.textContent, '2 files attached');

  const snippetsChip = chip('text-snippets');
  assert.ok(snippetsChip, 'expected a text snippets attachment summary chip');
  assert.equal(snippetsChip.textContent, '1 text snippets');

  const bubbleText = root.textContent ?? '';
  assert.match(bubbleText, /Please polish this copy/);
  assert.doesNotMatch(bubbleText, /Files attached:/);
  assert.doesNotMatch(bubbleText, /Text snippets attached:/);
});

test('snippet-only user message still renders a bubble with the chip', {
  timeout: 20_000,
}, async (t) => {
  const dom = installDom();
  const { harness, tempDir } = await importHarness();
  const root = document.querySelector('#root');

  let unmountRef = null;
  t.after(async () => {
    await unmountRef?.();
    await fs.rm(tempDir, { recursive: true, force: true });
    dom.window.close();
    await stopEsbuild();
  });

  const mounted = await harness.mount(root, userMessage('Text snippets attached: 1'));
  unmountRef = mounted.unmount;

  const snippetsChip = chip('text-snippets');
  assert.ok(snippetsChip, 'expected the snippet chip to keep the bubble alive');
  assert.equal(snippetsChip.textContent, '1 text snippets');
  assert.doesNotMatch(root.textContent ?? '', /Text snippets attached:/);
});

test('assistant prose mentioning the summary line stays plain text', {
  timeout: 20_000,
}, async (t) => {
  const dom = installDom();
  const { harness, tempDir } = await importHarness();
  const root = document.querySelector('#root');

  let unmountRef = null;
  t.after(async () => {
    await unmountRef?.();
    await fs.rm(tempDir, { recursive: true, force: true });
    dom.window.close();
    await stopEsbuild();
  });

  const mounted = await harness.mount(root, {
    ...userMessage('Text snippets attached: 9 will not be styled here.'),
    msgType: 'assistant',
  });
  unmountRef = mounted.unmount;

  assert.equal(chip('text-snippets'), null, 'assistant messages must not render summary chips');
  assert.match(root.textContent ?? '', /Text snippets attached: 9 will not be styled here\./);
});
