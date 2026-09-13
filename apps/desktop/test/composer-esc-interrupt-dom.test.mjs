import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build, stop: stopEsbuild } = require('esbuild');
const { JSDOM } = require('jsdom');
import { pathToFileURL, fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const stubsPlugin = {
  name: 'ccem-composer-esc-interrupt-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/webcontentRecovery$/ }, () => ({ path: 'recovery-stub', namespace: 'composer-esc-stubs' }));
    builder.onLoad({ filter: /^recovery-stub$/, namespace: 'composer-esc-stubs' }, () => ({
      loader: 'js', contents: 'export const isRecoveringWebcontent = () => false;',
    }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
      path: 'tauri-core-stub', namespace: 'composer-esc-stubs',
    }));
    builder.onLoad({ filter: /^tauri-core-stub$/, namespace: 'composer-esc-stubs' }, () => ({
      loader: 'js',
      contents: 'export async function invoke(command, args) { return globalThis.__escInterruptInvoke ? globalThis.__escInterruptInvoke(command, args) : []; }',
    }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({
      path: 'tauri-window-stub', namespace: 'composer-esc-stubs',
    }));
    builder.onLoad({ filter: /^tauri-window-stub$/, namespace: 'composer-esc-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function getCurrentWindow() {
          return { async onDragDropEvent() { return () => {}; } };
        }
      `,
    }));
    builder.onResolve({ filter: /^sonner$/ }, () => ({
      path: 'sonner-stub', namespace: 'composer-esc-stubs',
    }));
    builder.onLoad({ filter: /^sonner-stub$/, namespace: 'composer-esc-stubs' }, () => ({
      loader: 'js',
      contents: 'export const toast = { error() {}, success() {}, warning() {} };',
    }));
    builder.onResolve({ filter: /^\.\/composerRouteDraft$/ }, (args) => {
      if (!args.importer.endsWith('WorkspaceSessionComposer.tsx')) return null;
      return { path: 'composer-route-draft-stub', namespace: 'composer-esc-stubs' };
    });
    builder.onLoad({ filter: /^composer-route-draft-stub$/, namespace: 'composer-esc-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function isRouteDraftPillVisible() { return false; }
        export function isRouteDraftRowVisible() { return false; }
        export function toggleComposerRouteDraft() { return { optIn: true, profileId: null }; }
      `,
    }));
    builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({
      path: 'gsap-motion-stub', namespace: 'composer-esc-stubs',
    }));
    builder.onLoad({ filter: /^gsap-motion-stub$/, namespace: 'composer-esc-stubs' }, () => ({
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
      path: 'locale-stub', namespace: 'composer-esc-stubs',
    }));
    builder.onLoad({ filter: /^locale-stub$/, namespace: 'composer-esc-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function useLocale() {
          return { t(key) { return key; }, lang: 'zh' };
        }
      `,
    }));
    builder.onResolve({ filter: /^\.\/WorkspaceRouter$/ }, (args) => {
      if (!args.importer.endsWith('WorkspaceSessionComposer.tsx')) return null;
      return { path: 'workspace-router-stub', namespace: 'composer-esc-stubs' };
    });
    builder.onLoad({ filter: /^workspace-router-stub$/, namespace: 'composer-esc-stubs' }, () => ({
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-composer-esc-interrupt-'));
  const outputPath = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      resolveDir: desktopDir,
      sourcefile: 'harness.jsx',
      loader: 'jsx',
      contents: `
        const React = require('react');
        const { act, useState } = require('react');
        const { createRoot } = require('react-dom/client');
        const { WorkspaceSessionComposer } = require('@/components/workspace/WorkspaceSessionComposer');

        // Mounts the real WorkspaceSessionComposer with the same props shape the
        // live native session view passes for the double-Esc interrupt flow.
        exports.mountComposer = function mountComposer(container, options = {}) {
          const state = { interrupts: 0, submits: 0 };
          function Harness() {
            const [value, setValue] = useState('');
            return React.createElement(WorkspaceSessionComposer, {
              value,
              onValueChange: setValue,
              onSubmit() { state.submits += 1; return true; },
              placeholder: 'composer input',
              canSubmit: true,
              submitLabel: 'send message',
              escInterruptAvailable: options.available ?? true,
              onEscInterrupt() { state.interrupts += 1; },
            });
          }
          const root = createRoot(container);
          act(() => root.render(React.createElement(Harness)));
          return {
            state,
            editor() { return container.querySelector('[contenteditable="true"]'); },
            button() { return container.querySelector('button[data-workspace-composer-submit]'); },
            async press(key = 'Escape', extra = {}) {
              await act(async () => {
                container.querySelector('[contenteditable="true"]').dispatchEvent(
                  new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }),
                );
              });
            },
            async clickPrimary() {
              await act(async () => {
                container.querySelector('button[data-workspace-composer-submit]').click();
              });
            },
            unmount() { act(() => root.unmount()); },
          };
        };
      `,
    },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    outfile: outputPath,
    plugins: [stubsPlugin, aliasPlugin],
    logLevel: 'silent',
  });
  const harness = await import(pathToFileURL(outputPath).href);
  return { mountComposer: harness.mountComposer, tempDir };
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
  expose('sessionStorage', window.sessionStorage);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('MessageChannel', TestMessageChannel);
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  class TestURL extends window.URL { static createObjectURL() { return 'blob:test-image'; } static revokeObjectURL() {} }
  expose('URL', TestURL);

  for (const name of [
    'File',
    'FileReader',
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

test('first Esc arms the confirm state, second Esc interrupts the running session', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  const { mountComposer } = await (importedHarnessPromise ??= importHarness());

  const composer = mountComposer(container, { available: true });
  const button = () => container.querySelector('button[data-workspace-composer-submit]');

  assert.equal(button().getAttribute('aria-label'), 'send message');
  assert.equal(button().getAttribute('data-esc-interrupt'), null);

  await composer.press('Escape');
  assert.equal(button().getAttribute('data-esc-interrupt'), 'armed');
  assert.equal(button().getAttribute('aria-label'), 'workspace.composerEscInterruptArmed');
  assert.equal(button().getAttribute('title'), 'workspace.composerEscInterruptArmed');
  assert.equal(button().disabled, false);
  assert.equal(composer.state.interrupts, 0, 'first Esc must not interrupt');

  await composer.press('Escape');
  assert.equal(button().getAttribute('data-esc-interrupt'), null);
  assert.equal(button().getAttribute('aria-label'), 'send message');
  assert.equal(composer.state.interrupts, 1, 'second Esc interrupts exactly once');

  composer.unmount();
});

test('typing cancels the armed state, so a later Esc re-arms instead of interrupting', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  const { mountComposer } = await (importedHarnessPromise ??= importHarness());

  const composer = mountComposer(container, { available: true });
  const button = () => container.querySelector('button[data-workspace-composer-submit]');

  await composer.press('Escape');
  assert.equal(button().getAttribute('data-esc-interrupt'), 'armed');

  await composer.press('a');
  assert.equal(button().getAttribute('data-esc-interrupt'), null, 'typing disarms the confirm state');

  await composer.press('Escape');
  assert.equal(button().getAttribute('data-esc-interrupt'), 'armed', 'Esc re-arms after disarm');
  assert.equal(composer.state.interrupts, 0);

  composer.unmount();
});

test('the armed button click performs the interrupt directly', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  const { mountComposer } = await (importedHarnessPromise ??= importHarness());

  const composer = mountComposer(container, { available: true });
  const button = () => container.querySelector('button[data-workspace-composer-submit]');

  await composer.press('Escape');
  await composer.clickPrimary();
  assert.equal(composer.state.interrupts, 1);
  assert.equal(composer.state.submits, 0, 'armed click must not submit the draft');
  assert.equal(button().getAttribute('data-esc-interrupt'), null);

  composer.unmount();
});

test('Escape stays inert when the session is not interruptable', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  const { mountComposer } = await (importedHarnessPromise ??= importHarness());

  const composer = mountComposer(container, { available: false });
  const button = () => container.querySelector('button[data-workspace-composer-submit]');

  await composer.press('Escape');
  await composer.press('Escape');
  assert.equal(button().getAttribute('data-esc-interrupt'), null);
  assert.equal(button().getAttribute('aria-label'), 'send message');
  assert.equal(composer.state.interrupts, 0);

  composer.unmount();
});

test('the armed state expires on its own so it cannot hijack a later send', async (t) => {
  const { container, restore } = installDom();
  t.after(() => restore());
  const { mountComposer } = await (importedHarnessPromise ??= importHarness());

  const composer = mountComposer(container, { available: true });
  const button = () => container.querySelector('button[data-workspace-composer-submit]');

  await composer.press('Escape');
  assert.equal(button().getAttribute('data-esc-interrupt'), 'armed');

  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal(button().getAttribute('data-esc-interrupt'), null, 'armed state auto-expires');
  assert.equal(composer.state.interrupts, 0);

  composer.unmount();
});
