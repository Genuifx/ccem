import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const desktopDir = path.resolve(import.meta.dirname, '..');
let importedHarnessPromise;

test.after(async () => {
  if (importedHarnessPromise) {
    const importedHarness = await importedHarnessPromise;
    await fs.rm(importedHarness.tempDir, { recursive: true, force: true });
  }
  stopEsbuild();
});

async function resolveDesktopSource(importPath) {
  const base = path.join(desktopDir, 'src', importPath.slice(2));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next source shape.
    }
  }
  return null;
}

const stubsPlugin = {
  name: 'ccem-composer-submit-reentry-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/webcontentRecovery$/ }, () => ({
      path: 'recovery-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^recovery-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: 'export function isRecoveringWebcontent() { return window.__ccemRecoveryTest === true; }',
    }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
      path: 'tauri-core-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^tauri-core-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: 'export async function invoke() { return []; }',
    }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({
      path: 'tauri-window-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^tauri-window-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function getCurrentWindow() {
          return { async onDragDropEvent() { return () => {}; } };
        }
      `,
    }));
    builder.onResolve({ filter: /^sonner$/ }, () => ({
      path: 'sonner-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^sonner-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: 'export const toast = { error() {}, success() {}, warning() {} };',
    }));
    builder.onResolve({ filter: /^\.\/composerRouteDraft$/ }, (args) => {
      if (!args.importer.endsWith('WorkspaceSessionComposer.tsx')) return null;
      return { path: 'composer-route-draft-stub', namespace: 'composer-submit-stubs' };
    });
    builder.onLoad({ filter: /^composer-route-draft-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function isRouteDraftPillVisible() { return false; }
        export function isRouteDraftRowVisible() { return false; }
        export function toggleComposerRouteDraft() { return { optIn: true, profileId: null }; }
      `,
    }));
    builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({
      path: 'gsap-motion-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^gsap-motion-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: `
        export const ccemMotion = {
          duration: { quick: 0, base: 0 },
          ease: { standard: 'none' },
        };
        export function clearMotionProps() {}
        export const gsap = {
          fromTo() {},
          set() {},
          utils: { toArray() { return []; } },
        };
        export function shouldReduceMotion() { return true; }
        export function useGSAP() {}
      `,
    }));
    builder.onResolve({ filter: /^@\/locales$/ }, () => ({
      path: 'locale-stub', namespace: 'composer-submit-stubs',
    }));
    builder.onLoad({ filter: /^locale-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function useLocale() {
          return { t(key) { return key; }, lang: 'zh' };
        }
      `,
    }));
    builder.onResolve({ filter: /^\.\/WorkspaceRouter$/ }, (args) => {
      if (!args.importer.endsWith('WorkspaceSessionComposer.tsx')) return null;
      return { path: 'workspace-router-stub', namespace: 'composer-submit-stubs' };
    });
    builder.onLoad({ filter: /^workspace-router-stub$/, namespace: 'composer-submit-stubs' }, () => ({
      loader: 'jsx',
      contents: `
        export function WorkspaceRoutePill() { return null; }
        export function ComposerRouteDraftRow() { return null; }
        export function ComposerRouteDraftPill() { return null; }
      `,
    }));
  },
};

const aliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => ({
      path: await resolveDesktopSource(args.path),
    }));
  },
};

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-composer-submit-reentry-'));
  const outputPath = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { WorkspaceSessionComposer } from '@/components/workspace/WorkspaceSessionComposer';
        import { readRecoveryDraft, writeRecoveryDraft, recoveryDraftDiagnostics } from '@/lib/recoveryDrafts';

        export function seedRecovery(key, text, attachments) { writeRecoveryDraft(key, text, attachments); }
        export function recoveredDraft(key) { return readRecoveryDraft(key, true); }
        export function recoveryCounts() { return recoveryDraftDiagnostics(); }

        export function renderNativeQueuedComposer() {
          return renderToStaticMarkup(
            <WorkspaceSessionComposer
              value=""
              onValueChange={() => {}}
              onSubmit={() => {}}
              placeholder="composer input"
              canSubmit={false}
              submitLabel="send message"
              queuedMessages={[{
                id: 'native-queued-message',
                text: 'wait above composer',
                displayText: 'wait above composer',
                deliveryState: 'pending',
                removable: true,
                flushable: false,
              }]}
              onFlushQueuedMessages={() => {}}
              onRemoveQueuedMessage={() => {}}
              queueCanFlush
            />
          );
        }

        export function renderMixedQueuedComposer() {
          return renderToStaticMarkup(
            <WorkspaceSessionComposer
              value=""
              onValueChange={() => {}}
              onSubmit={() => {}}
              placeholder="composer input"
              canSubmit={false}
              submitLabel="send message"
              queuedMessages={[
                {
                  id: 'native-first',
                  text: 'native first',
                  deliveryState: 'pending',
                  removable: true,
                  flushable: false,
                },
                {
                  id: 'legacy-second',
                  text: 'legacy second',
                },
              ]}
              onFlushQueuedMessages={() => {}}
              onRemoveQueuedMessage={() => {}}
              queueCanFlush
            />
          );
        }

        export function mount(container, options = {}) {
          const state = {
            calls: 0,
            pending: [],
            payloads: [],
          };

          function Harness() {
            const [value, setValue] = useState(() => options.recoveryKey
              ? readRecoveryDraft(options.recoveryKey, true)?.text ?? '' : 'same-tick message');
            return (
              <WorkspaceSessionComposer
                value={value}
                recoveryDraftKey={options.recoveryKey}
                onValueChange={setValue}
                onSubmit={(payload) => {
                  state.calls += 1;
                  state.payloads.push(payload);
                  if (options.throwAfterDispatch) return Promise.reject(new Error('private transport error'));
                  return new Promise((resolve) => state.pending.push(resolve));
                }}
                placeholder="composer input"
                canSubmit
                submitLabel="send message"
              />
            );
          }

          const root = createRoot(container);
          act(() => root.render(<Harness />));
          const editor = container.querySelector('[contenteditable="true"]');
          const sendButton = container.querySelector('button[aria-label="send message"]');
          if (!editor || !sendButton) throw new Error('composer controls did not mount');

          return {
            submitWithEnterAndClick() {
              act(() => {
                editor.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'Enter',
                  code: 'Enter',
                  bubbles: true,
                  cancelable: true,
                }));
                sendButton.click();
              });
            },
            pressEnter() {
              act(() => editor.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                bubbles: true,
                cancelable: true,
              })));
            },
            getCallCount() { return state.calls; },
            getPayloads() { return state.payloads; },
            getText() { return editor.textContent; },
            recoverRejected() {
              act(() => container.querySelector('[data-composer-rejected-draft] button').click());
            },
            typeText(text) {
              act(() => {
                editor.textContent = text;
                editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
              });
            },
            async resolveAll(result) {
              const pending = state.pending.splice(0);
              await act(async () => {
                pending.forEach((resolve) => resolve(result));
                await Promise.resolve();
              });
            },
            unmount() {
              act(() => root.unmount());
            },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [stubsPlugin, aliasPlugin],
    logLevel: 'silent',
    external: ['jsdom'],
  });
  const imported = await import(pathToFileURL(outputPath).href);
  return { ...imported, tempDir };
}

test('native queued prompt renders in the dock before and outside the composer card', async () => {
  const { renderNativeQueuedComposer } = await importHarness();
  const dom = new JSDOM(`<!doctype html><html><body>${renderNativeQueuedComposer()}</body></html>`);
  const queue = dom.window.document.querySelector('[data-ccem-composer-queue]');
  const item = dom.window.document.querySelector(
    '[data-ccem-composer-queued-message="native-queued-message"]',
  );
  const card = dom.window.document.querySelector('[data-composer-shell-card]');

  assert.ok(queue, 'the composer queue dock must render');
  assert.ok(item, 'the native queued prompt must render in the queue dock');
  assert.ok(card, 'the composer card must render');
  assert.equal(card.contains(item), false, 'queued prompt must not be inside the composer card');
  assert.ok(
    queue.compareDocumentPosition(card) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'queue dock must precede the composer card',
  );
  const heading = queue.querySelector('[data-ccem-composer-queue-heading]');
  assert.ok(heading, 'queue heading must render');
  assert.match(heading.textContent, /workspace\.composerGuideModel/);
  assert.match(heading.textContent, /workspace\.composerQueuedWaiting/);
  assert.doesNotMatch(queue.textContent, /workspace\.composerQueuedCount/);
  assert.match(item.textContent, /workspace\.messageQueuedBadge/);
  assert.match(queue.textContent, /workspace\.composerQueuedWaiting/);
  assert.doesNotMatch(queue.textContent, /workspace\.composerQueuedReady/);
  assert.ok(
    item.querySelector('[aria-label="workspace.composerRemoveQueued"]'),
    'pending backend-owned queue rows must expose the safe cancel action',
  );
  assert.equal(
    queue.querySelector('button:not([aria-label="workspace.composerRemoveQueued"])'),
    null,
    'backend-owned queue rows must not expose the legacy flush action',
  );
});

test('mixed native and legacy queues expose no misleading list-wide flush action', async () => {
  const { renderMixedQueuedComposer } = await importHarness();
  const dom = new JSDOM(`<!doctype html><html><body>${renderMixedQueuedComposer()}</body></html>`);
  const queue = dom.window.document.querySelector('[data-ccem-composer-queue]');
  const rows = [...dom.window.document.querySelectorAll('[data-ccem-composer-queued-message]')];

  assert.ok(queue);
  assert.deepEqual(
    rows.map((row) => row.getAttribute('data-ccem-composer-queued-message')),
    ['native-first', 'legacy-second'],
  );
  assert.equal(
    queue.querySelector('button:not([aria-label="workspace.composerRemoveQueued"])'),
    null,
    'mixed queues must not expose a list-wide flush action that only flushes legacy rows',
  );
});

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const { window } = dom;
  const previous = new Map();

  const expose = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };

  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })),
      };
    }
  }

  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('localStorage', window.localStorage);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('MessageChannel', TestMessageChannel);
  expose('IS_REACT_ACT_ENVIRONMENT', true);

  for (const name of [
    'Node',
    'NodeFilter',
    'Text',
    'Element',
    'HTMLElement',
    'HTMLBRElement',
    'HTMLAnchorElement',
    'Event',
    'InputEvent',
    'CompositionEvent',
    'KeyboardEvent',
    'MouseEvent',
    'MutationObserver',
    'DOMRect',
    'Range',
  ]) {
    expose(name, window[name]);
  }

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  expose('ResizeObserver', ResizeObserver);
  let nextAnimationFrameHandle = 1;
  const animationFrames = new Map();
  expose('requestAnimationFrame', (callback) => {
    const handle = nextAnimationFrameHandle++;
    animationFrames.set(handle, callback);
    return handle;
  });
  expose('cancelAnimationFrame', (handle) => animationFrames.delete(handle));
  expose('PointerEvent', window.PointerEvent ?? window.MouseEvent);
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  window.matchMedia = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  });
  expose('matchMedia', window.matchMedia);

  return {
    container: window.document.getElementById('root'),
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete globalThis[name];
        }
      }
    },
  };
}

test('Enter plus send click submits once while pending and re-arms after completion', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mount(container);

  mounted.submitWithEnterAndClick();
  const callsWhilePending = mounted.getCallCount();
  await mounted.resolveAll(false);

  mounted.pressEnter();
  const callsAfterCompletion = mounted.getCallCount();
  await mounted.resolveAll(false);
  mounted.unmount();

  assert.equal(callsWhilePending, 1, 'same-tick Enter and click must share one submission');
  assert.equal(callsAfterCompletion, 2, 'the guard must release after the first submission settles');
});

test('actual composer recovery restores text and image, never auto-sends, preserves rejection and clears admission', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  const harness = await (importedHarnessPromise ??= importHarness());
  window.__ccemRecoveryTest = true;
  const key = 'live:recovery-fixture';
  const attachment = { id: 'recovery-image', kind: 'image', source: 'paste', name: 'recovered.png',
    placeholder: '[Image #1]', mediaType: 'image/png', base64Data: 'aGVsbG8=', byteSize: 5, objectUrl: 'blob:dead' };
  harness.seedRecovery(key, 'saved message [Image #1]', [attachment]);
  const mounted = harness.mount(container, { recoveryKey: key });
  assert.equal(mounted.getCallCount(), 0);
  assert.match(mounted.getText(), /saved message/);
  assert.equal(container.querySelector('[data-composer-attachment-chip] img').getAttribute('src'), 'data:image/png;base64,aGVsbG8=');
  mounted.pressEnter();
  assert.equal(mounted.getCallCount(), 1);
  assert.equal(mounted.getPayloads()[0].attachments[0].base64Data, attachment.base64Data);
  assert.equal(harness.recoveredDraft(key), null, 'in-flight snapshot is not sendable after crash');
  assert.equal(harness.recoveryCounts().uncertain, 1);
  await mounted.resolveAll(false);
  assert.equal(harness.recoveredDraft(key).text, 'saved message [Image #1]');
  mounted.pressEnter();
  await mounted.resolveAll(true);
  assert.equal(harness.recoveredDraft(key), null, 'accepted image and text must not resurrect');
  assert.equal(harness.recoveryCounts().uncertain, 0);
  mounted.unmount();
  const remounted = harness.mount(container, { recoveryKey: key });
  assert.equal(remounted.getText(), '');
  assert.equal(remounted.getCallCount(), 0);
  assert.equal(container.querySelectorAll('[data-composer-attachment-chip]').length, 0);
  remounted.unmount();
});

test('actual editor journals an unsent keystroke before unmount and preserves a newer draft after ACK', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  const harness = await (importedHarnessPromise ??= importHarness());
  window.__ccemRecoveryTest = true;
  const key = 'live:typing-fixture';
  const mounted = harness.mount(container, { recoveryKey: key });
  mounted.typeText('first unsent edit');
  assert.equal(harness.recoveredDraft(key).text, 'first unsent edit');
  mounted.pressEnter();
  mounted.typeText('newer unsent edit');
  await mounted.resolveAll(true);
  assert.equal(harness.recoveredDraft(key).text, 'newer unsent edit');
  mounted.unmount();
  const remounted = harness.mount(container, { recoveryKey: key });
  assert.equal(remounted.getText(), 'newer unsent edit');
  assert.equal(remounted.getCallCount(), 0);
  remounted.unmount();
});

test('rejected secondary card survives document replacement and restores only after an explicit click', async (t) => {
  const { container, restore } = installDom(); t.after(() => restore());
  const harness = await (importedHarnessPromise ??= importHarness()); window.__ccemRecoveryTest = true;
  const key = 'live:rejected-crash-fixture';
  harness.seedRecovery(key, 'older rejected draft [Image #1]', [{
    id: 'rejected-image', kind: 'image', source: 'paste', name: 'rejected.png', placeholder: '[Image #1]',
    mediaType: 'image/png', base64Data: 'aGVsbG8=', byteSize: 5, objectUrl: 'blob:dead',
  }]);
  const mounted = harness.mount(container, { recoveryKey: key });
  mounted.pressEnter(); mounted.typeText('newer draft'); await mounted.resolveAll(false);
  assert.equal(harness.recoveryCounts().rejected, 1); mounted.unmount();
  const remounted = harness.mount(container, { recoveryKey: key });
  assert.equal(remounted.getText(), 'newer draft'); assert.equal(remounted.getCallCount(), 0);
  const rejected = container.querySelector('[data-composer-rejected-draft]');
  assert.match(rejected.textContent, /older rejected draft/);
  // Actual recovery button gesture; it merges into the editor and sends nothing.
  remounted.recoverRejected();
  assert.equal(remounted.getCallCount(), 0);
  assert.equal(harness.recoveryCounts().rejected, 0);
  assert.match(harness.recoveredDraft(key).text, /older rejected draft/);
  assert.equal(harness.recoveredDraft(key).attachments[0].base64Data, 'aGVsbG8=');
  assert.equal(container.querySelector('[data-composer-attachment-chip] img').getAttribute('src'), 'data:image/png;base64,aGVsbG8=');
  remounted.unmount();
});

test('unexpected onSubmit rejection is handled without clearing the uncertain journal or producing a rejected draft', async (t) => {
  const { container, restore } = installDom();
  t.after(restore);
  const harness = await (importedHarnessPromise ??= importHarness());
  window.__ccemRecoveryTest = true;
  const key = 'live:unexpected-submit-throw';
  harness.seedRecovery(key, 'private unsent draft', []);
  const mounted = harness.mount(container, { recoveryKey: key, throwAfterDispatch: true });
  const originalWarn = console.warn; const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    mounted.pressEnter();
    await mounted.resolveAll(false);
    assert.equal(mounted.getCallCount(), 1);
    assert.equal(mounted.getText(), 'private unsent draft');
    assert.equal(harness.recoveryCounts().uncertain, 1);
    assert.equal(harness.recoveredDraft(key), null);
    assert.equal(container.querySelectorAll('[data-composer-rejected-draft]').length, 0);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(warnings), /private|transport error/);
  } finally { console.warn = originalWarn; }
  mounted.unmount();
  const remounted = harness.mount(container, { recoveryKey: key });
  assert.equal(remounted.getText(), '');
  assert.equal(remounted.getCallCount(), 0);
  assert.equal(harness.recoveryCounts().uncertain, 1);
  remounted.unmount();
});
