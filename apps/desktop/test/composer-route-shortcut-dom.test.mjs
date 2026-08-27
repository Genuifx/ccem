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
      // Try next shape.
    }
  }
  return null;
}

const aliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => ({
      path: await resolveDesktopSource(args.path),
    }));
  },
};

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-route-shortcut-'));
  const outputPath = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { PromptArea } from '@/components/prompt-area';
        import { buildComposerRouteShortcutHandler } from '@/components/workspace/composerRouteShortcut';

        // Uses the same handler builder as WorkspaceSessionComposer and the
        // real PromptArea event surface. The final parent submit chain is
        // verified separately in the Workspace behavior smoke.
        export function mount(container, options = {}) {
          const state = {
            draft: options.initialDraft ?? { optIn: false, profileId: null },
            enableCalls: 0,
            lastEventDefaultPrevented: null,
          };

          function Harness() {
            const [draft, setDraft] = useState(state.draft);
            state.draft = draft;
            const handler = buildComposerRouteShortcutHandler({
              provider: options.provider ?? 'claude',
              routeDraft: options.routeUnavailable ? null : draft,
              onRouteDraftEnable: options.routeUnavailable
                ? undefined
                : () => {
                    state.enableCalls += 1;
                    setDraft((current) => (current.optIn ? current : { optIn: true, profileId: null }));
                  },
              disabled: options.disabled ?? false,
              isSubmitting: options.isSubmitting ?? false,
            });
            return (
              <PromptArea
                value={draft.optIn ? [{ type: 'text', text: 'pill-on' }] : [{ type: 'text', text: '' }]}
                onChange={() => {}}
                triggers={[]}
                markdown={false}
                data-test-id="composer-editor"
                aria-keyshortcuts="Shift+Backquote"
                minHeight={72}
                maxHeight={260}
                onKeyDown={(event) => {
                  state.lastEventDefaultPrevented = null;
                  handler(event);
                  state.lastEventDefaultPrevented = event.defaultPrevented;
                }}
              />
            );
          }

          const root = createRoot(container);
          act(() => root.render(<Harness />));
          const editor = container.querySelector('[data-test-id="composer-editor"]');
          if (!editor) throw new Error('prompt area editor did not mount');
          return {
            editor,
            getDraft() { return state.draft; },
            getEnableCalls() { return state.enableCalls; },
            wasDefaultPrevented() { return state.lastEventDefaultPrevented; },
            pressBackquote(modifiers = {}) {
              const event = new KeyboardEvent('keydown', {
                key: modifiers.key ?? '~',
                code: modifiers.code ?? 'Backquote',
                shiftKey: modifiers.shiftKey ?? true,
                metaKey: modifiers.metaKey ?? false,
                ctrlKey: modifiers.ctrlKey ?? false,
                altKey: modifiers.altKey ?? false,
                repeat: modifiers.repeat ?? false,
                bubbles: true,
                cancelable: true,
              });
              if (modifiers.isComposing) {
                Object.defineProperty(event, 'isComposing', { get: () => true });
              }
              if (modifiers.keyCode != null) {
                Object.defineProperty(event, 'keyCode', { get: () => modifiers.keyCode });
              }
              act(() => editor.dispatchEvent(event));
              return event;
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
    plugins: [aliasPlugin],
    logLevel: 'silent',
    external: ['jsdom'],
  });
  const imported = await import(pathToFileURL(outputPath).href);
  return { ...imported, tempDir };
}

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

  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('IS_REACT_ACT_ENVIRONMENT', true);

  for (const name of [
    'Node',
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

  let nextAnimationFrameHandle = 1;
  const animationFrames = new Map();
  const requestAnimationFrame = (callback) => {
    const handle = nextAnimationFrameHandle++;
    animationFrames.set(handle, callback);
    return handle;
  };
  const cancelAnimationFrame = (handle) => {
    animationFrames.delete(handle);
  };

  expose('ResizeObserver', ResizeObserver);
  expose('requestAnimationFrame', requestAnimationFrame);
  expose('cancelAnimationFrame', cancelAnimationFrame);
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserver });
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: requestAnimationFrame });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: cancelAnimationFrame });

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

test('Shift+~ on real PromptArea enables routing without inserting a character', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  {
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mount(container);
    const event = mounted.pressBackquote();
    assert.equal(event.defaultPrevented, true, 'composer consumes the gesture');
    assert.equal(mounted.getEnableCalls(), 1);
    assert.deepEqual(mounted.getDraft(), { optIn: true, profileId: null });
    assert.equal(mounted.editor.getAttribute('aria-keyshortcuts'), 'Shift+Backquote');
    mounted.unmount();
  }
});

test('repeat Shift+~ while already on: swallowed, no reset, no extra callback', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  {
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mount(container, {
      initialDraft: { optIn: true, profileId: 'profile-a' },
    });
    const repeatEvent = mounted.pressBackquote({ repeat: true });
    assert.equal(repeatEvent.defaultPrevented, false, 'repeat is ignored entirely');
    assert.equal(mounted.getEnableCalls(), 0);

    // Non-repeat while already ON: swallow, keep the named profile.
    const swallowed = mounted.pressBackquote();
    assert.equal(swallowed.defaultPrevented, true);
    assert.equal(mounted.getEnableCalls(), 0, 'idempotent enable — no callback when already on');
    assert.equal(mounted.getDraft().profileId, 'profile-a', 'named profile not reset');
    mounted.unmount();
  }
});

test('IME composition, Process, keyCode 229, and non-shift modifiers do not trigger', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  {
    const harness = await (importedHarnessPromise ??= importHarness());
    const mounted = harness.mount(container);
    mounted.pressBackquote({ isComposing: true });
    assert.equal(mounted.getEnableCalls(), 0);
    assert.equal(mounted.wasDefaultPrevented(), false, 'IME composing must not swallow the key');

    mounted.pressBackquote({ keyCode: 229 });
    assert.equal(mounted.getEnableCalls(), 0);

    mounted.pressBackquote({ key: 'Process' });
    assert.equal(mounted.getEnableCalls(), 0);
    assert.equal(mounted.wasDefaultPrevented(), false);

    mounted.pressBackquote({ metaKey: true });
    mounted.pressBackquote({ ctrlKey: true });
    mounted.pressBackquote({ altKey: true });
    mounted.pressBackquote({ shiftKey: false, key: '`', code: 'Backquote' });
    assert.equal(mounted.getEnableCalls(), 0);
    assert.equal(mounted.wasDefaultPrevented(), false, 'modifiers keep the normal character path');
    assert.equal(mounted.getDraft().optIn, false);
    mounted.unmount();
  }
});

test('codex provider, disabled, submitting, and live-direct composers do not consume', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  {
    const harness = await (importedHarnessPromise ??= importHarness());
    for (const options of [
      { provider: 'codex' },
      { disabled: true },
      { isSubmitting: true },
      { routeUnavailable: true },
    ]) {
      container.innerHTML = '';
      const mounted = harness.mount(container, options);
      mounted.pressBackquote();
      assert.equal(mounted.getEnableCalls(), 0, JSON.stringify(options));
      assert.equal(mounted.wasDefaultPrevented(), false, 'character flows through: ' + JSON.stringify(options));
      mounted.unmount();
    }
  }
});
