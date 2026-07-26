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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-message-annotations-bubble-'));
  const outfile = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { TooltipProvider } from '@/components/ui/tooltip';
        import { WorkspaceMessageBubble } from '@/components/workspace/WorkspaceMessageBubble';

        const message = {
          msgType: 'user',
          uuid: 'sent-annotation-message',
          content: 'Please update this interaction',
          annotations: [{
            quote: 'const interaction = before',
            note: 'keep the sent annotation visible',
          }],
          timestamp: Date.parse('2026-07-26T10:00:00.000Z'),
          segmentIndex: 0,
          isCompactBoundary: false,
        };

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

        export function mount(container) {
          const root = createRoot(container);
          act(() => root.render(
            <TooltipProvider>
              <WorkspaceMessageBubble message={message} prevRole={null} />
            </TooltipProvider>
          ));
          return {
            async mouseClick(element) {
              act(() => {
                element.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true,
                  button: 0,
                  pointerType: 'mouse',
                }));
                element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
                element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
                element.click();
              });
              await flushInteraction();
            },
            async outsideClick(element) {
              act(() => {
                element.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true,
                  button: 0,
                  pointerType: 'mouse',
                }));
                element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
                element.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true,
                  button: 0,
                  pointerType: 'mouse',
                }));
                element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
                element.click();
              });
              await flushInteraction();
            },
            async keyboardActivate(element, key) {
              element.focus();
              act(() => {
                const accepted = element.dispatchEvent(new KeyboardEvent('keydown', {
                  key,
                  code: key === ' ' ? 'Space' : key,
                  bubbles: true,
                  cancelable: true,
                }));
                if (accepted) {
                  element.click();
                }
                element.dispatchEvent(new KeyboardEvent('keyup', {
                  key,
                  code: key === ' ' ? 'Space' : key,
                  bubbles: true,
                }));
              });
              await flushInteraction();
            },
            async pressEscape() {
              act(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'Escape',
                  code: 'Escape',
                  bubbles: true,
                  cancelable: true,
                }));
              });
              await flushInteraction();
            },
            unmount() {
              act(() => root.unmount());
            },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'workspace-message-annotations-bubble-harness.tsx',
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
              'workspace.messageAnnotationsView': 'View annotations',
              'workspace.messageAnnotationsTitle': '{count} annotations sent',
              'workspace.messageAnnotationIndex': 'Annotation {index}',
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
    '<!doctype html><html><body><button id="outside">Outside</button><div id="root"></div></body></html>',
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

function annotationTrigger() {
  return document.querySelector('[data-workspace-message-annotations-trigger]');
}

function annotationDialog() {
  return document.querySelector('[data-workspace-message-annotations-popover]');
}

test('real user bubble supports mouse and keyboard annotation popover dismissal with focus return', {
  timeout: 15_000,
}, async (t) => {
  const dom = installDom();
  const { harness: { mount }, tempDir } = await importHarness();
  const harness = mount(document.querySelector('#root'));

  t.after(async () => {
    harness.unmount();
    await new Promise((resolve) => setImmediate(resolve));
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const trigger = annotationTrigger();
  assert.ok(trigger);
  assert.equal(trigger.tagName, 'BUTTON');
  assert.equal(trigger.getAttribute('aria-label'), 'View annotations');

  await harness.mouseClick(trigger);
  let dialog = annotationDialog();
  assert.ok(dialog);
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-label'), '1 annotations sent');
  assert.match(dialog.textContent, /const interaction = before/);
  assert.match(dialog.textContent, /keep the sent annotation visible/);

  await harness.mouseClick(trigger);
  assert.ok(annotationDialog() === null, 'expected trigger click to close the popover');

  await harness.mouseClick(trigger);
  assert.ok(annotationDialog());
  await harness.outsideClick(document.querySelector('#outside'));
  assert.ok(annotationDialog() === null, 'expected outside click to close the popover');

  await harness.keyboardActivate(trigger, 'Enter');
  assert.ok(annotationDialog());
  await harness.pressEscape();
  assert.ok(annotationDialog() === null, 'expected Escape to close the popover');
  assert.ok(
    document.activeElement === trigger,
    `expected focus to return to trigger, got ${document.activeElement?.tagName ?? 'none'}`,
  );

  await harness.keyboardActivate(trigger, ' ');
  assert.ok(annotationDialog());
  await harness.keyboardActivate(trigger, ' ');
  assert.ok(annotationDialog() === null, 'expected Space to toggle the popover closed');
  assert.ok(
    document.activeElement === trigger,
    `expected Space dismissal to retain trigger focus, got ${document.activeElement?.tagName ?? 'none'}`,
  );
});
