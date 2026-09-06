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

const harnessPlugin = {
  name: 'ccem-startup-splash-harness',
  setup(builder) {
    builder.onResolve({ filter: /^@\/locales$/ }, () => ({ path: 'locale', namespace: 'startup-splash-stub' }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'startup-splash-stub' }));
    builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({
      path: 'gsap-motion',
      namespace: 'startup-splash-stub',
    }));
    builder.onResolve({ filter: /MacFullscreenWindowControls$/ }, () => ({
      path: 'window-controls',
      namespace: 'startup-splash-stub',
    }));
    builder.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = await resolveDesktopSource(args.path);
      return resolved
        ? { path: resolved }
        : { errors: [{ text: `Could not resolve ${args.path}` }] };
    });
    builder.onLoad({ filter: /.*/, namespace: 'startup-splash-stub' }, (args) => {
      if (args.path === 'locale') return {
        loader: 'js', contents: 'export const useLocale = () => ({ t: (key) => key });',
      };
      if (args.path === 'ipc') return {
        loader: 'js', contents: 'export const invoke = (...args) => globalThis.__startupInvoke(...args);',
      };
      if (args.path === 'window-controls') {
        return {
          loader: 'js',
          resolveDir: desktopDir,
          contents: 'export function MacFullscreenWindowControls() { return null; }',
        };
      }
      return {
        loader: 'js',
        resolveDir: desktopDir,
        contents: `
          import { useLayoutEffect } from 'react';
          export const ccemMotion = {
            duration: { base: 0.28, handoff: 0.48 },
            ease: { soft: 'none', standard: 'none' },
          };
          export const gsap = {
            killTweensOf() {},
            fromTo() {},
            timeline() {
              // Deliberately never calls onComplete. This models a hidden
              // WebView whose requestAnimationFrame/GSAP ticker is suspended.
              return { to() { return this; } };
            },
          };
          export function shouldReduceMotion() { return false; }
          export function useGSAP(callback, config = {}) {
            useLayoutEffect(callback, config.dependencies ?? []);
          }
        `,
      };
    });
  },
};

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-startup-splash-'));
  const outputPath = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { StartupSplash } from '@/components/layout/StartupSplash';
        import { useStartup } from '@/hooks/useStartup';

        export { act };
        export function mountStartup(container) {
          function Harness() {
            const startup = useStartup(globalThis.__startupLoadConfig);
            return startup.ready ? <button data-testid="workspace">New conversation</button>
              : <StartupSplash phase={startup.phase} />;
          }
          const root = createRoot(container);
          act(() => root.render(<Harness />));
          return { unmount() { act(() => root.unmount()); } };
        }

        export function mount(container) {
          let setExiting;
          let setPhase;
          let exitCalls = 0;
          function Harness() {
            const [exiting, updateExiting] = useState(false);
            setExiting = updateExiting;
            const [phase, updatePhase] = useState("preparing");
            setPhase = updatePhase;
            return (
              <StartupSplash
                exiting={exiting}
                phase={phase}
                onExitComplete={() => { exitCalls += 1; }}
              />
            );
          }
          const root = createRoot(container);
          act(() => root.render(<Harness />));
          return {
            exit() { act(() => setExiting(true)); },
            exitCalls() { return exitCalls; },
            phase(value) { act(() => setPhase(value)); },
            unmount() { act(() => root.unmount()); },
          };
        }

        export async function wait(ms) {
          await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'startup-splash-harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [harnessPlugin],
    define: { 'process.env.NODE_ENV': '"test"' },
    logLevel: 'silent',
  });
  const imported = await import(pathToFileURL(outputPath).href);
  return { ...imported, tempDir };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const previous = new Map();
  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })),
      };
    }
  }
  const expose = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  expose('window', dom.window);
  expose('self', dom.window);
  expose('document', dom.window.document);
  expose('navigator', dom.window.navigator);
  expose('HTMLElement', dom.window.HTMLElement);
  expose('Element', dom.window.Element);
  expose('Node', dom.window.Node);
  expose('MessageChannel', TestMessageChannel);
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container: dom.window.document.getElementById('root'),
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test('startup splash exits even when the GSAP ticker is suspended', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const mounted = harness.mount(container);
  t.after(() => {
    mounted.unmount();
    restore();
  });

  mounted.exit();
  await harness.wait(850);

  assert.equal(mounted.exitCalls(), 1);
});

function virtualClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const oldSet = window.setTimeout;
  const oldClear = window.clearTimeout;
  const oldNow = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  window.setTimeout = (callback, delay = 0) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  return {
    async advance(ms, act) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        // Browsers do not await the promise returned by an async timer handler.
        await act(async () => { next[1].callback(); });
      }
      now = target;
      await act(async () => {});
    },
    restore() {
      window.setTimeout = oldSet;
      window.clearTimeout = oldClear;
      if (oldNow) Object.defineProperty(performance, 'now', oldNow);
      else delete performance.now;
    },
    get size() { return timers.size; },
  };
}

test('progress appears at 3 seconds, follows the current stage, and disappears on exit', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const clock = virtualClock();
  const mounted = harness.mount(container);
  t.after(() => { mounted.unmount(); clock.restore(); restore(); });
  await clock.advance(2999, harness.act);
  assert.equal(container.querySelector('[role="progressbar"]'), null);
  await clock.advance(1, harness.act);
  assert.equal(container.querySelector('[role="progressbar"]').getAttribute('data-state'), 'indeterminate');
  assert.equal(container.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow'), false);
  mounted.phase('restoringSessions');
  assert.equal(container.querySelector('[role="status"]').textContent, 'startup.restoringSessions');
  mounted.exit();
  assert.equal(container.querySelector('[role="progressbar"]'), null);
  await clock.advance(800, harness.act);
  assert.equal(mounted.exitCalls(), 1);
});

test('startup stays gated beyond the old 4.8 second deadline until native recovery finishes', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const clock = virtualClock();
  let phase = 'restoringSessions';
  globalThis.__startupInvoke = async () => phase;
  globalThis.__startupLoadConfig = async () => {};
  const mounted = harness.mountStartup(container);
  t.after(() => {
    mounted.unmount(); clock.restore(); restore();
    delete globalThis.__startupInvoke; delete globalThis.__startupLoadConfig;
  });
  await harness.act(async () => {});
  await clock.advance(5000, harness.act);
  assert.equal(container.querySelector('[data-testid="workspace"]'), null);
  assert.equal(container.querySelector('[role="status"]').textContent, 'startup.restoringSessions');
  phase = 'ready';
  await clock.advance(250, harness.act);
  assert.ok(container.querySelector('[data-testid="workspace"]'));
  assert.equal(container.querySelector('[role="progressbar"]'), null);
});

test('fast startup never shows progress and failed recovery never opens the workspace', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const clock = virtualClock();
  let phase = 'ready';
  globalThis.__startupInvoke = async () => phase;
  globalThis.__startupLoadConfig = async () => {};
  let mounted = harness.mountStartup(container);
  t.after(() => {
    mounted.unmount(); clock.restore(); restore();
    delete globalThis.__startupInvoke; delete globalThis.__startupLoadConfig;
  });
  await harness.act(async () => {});
  await clock.advance(760, harness.act);
  assert.ok(container.querySelector('[data-testid="workspace"]'));
  assert.equal(container.querySelector('[role="progressbar"]'), null);
  mounted.unmount();
  phase = 'failed';
  mounted = harness.mountStartup(container);
  await harness.act(async () => {});
  await clock.advance(5000, harness.act);
  assert.equal(container.querySelector('[data-testid="workspace"]'), null);
  assert.equal(container.querySelector('[role="alert"]').textContent, 'startup.failed');
  assert.equal(container.querySelector('[role="progressbar"]'), null);
});

test('rejected startup status reads release all timers on unmount', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const clock = virtualClock();
  let calls = 0;
  globalThis.__startupInvoke = async () => { calls += 1; throw new Error('bridge unavailable'); };
  globalThis.__startupLoadConfig = async () => {};
  const mounted = harness.mountStartup(container);
  t.after(() => {
    clock.restore(); restore();
    delete globalThis.__startupInvoke; delete globalThis.__startupLoadConfig;
  });
  await harness.act(async () => {});
  await clock.advance(750, harness.act);
  assert.equal(calls, 4);
  mounted.unmount();
  assert.equal(clock.size, 0);
  await clock.advance(30_000, harness.act);
  assert.equal(calls, 4);
});

test('unresponsive startup status eventually shows failure without opening the workspace', async (t) => {
  const { container, restore } = installDom();
  const harness = await (importedHarnessPromise ??= importHarness());
  const clock = virtualClock();
  globalThis.__startupInvoke = () => new Promise(() => {});
  globalThis.__startupLoadConfig = async () => {};
  const mounted = harness.mountStartup(container);
  t.after(() => {
    mounted.unmount(); clock.restore(); restore();
    delete globalThis.__startupInvoke; delete globalThis.__startupLoadConfig;
  });
  await harness.act(async () => {});
  await clock.advance(31_250, harness.act);
  assert.equal(container.querySelector('[data-testid="workspace"]'), null);
  assert.equal(container.querySelector('[role="progressbar"]'), null);
  assert.equal(container.querySelector('[role="alert"]').textContent, 'startup.failed');
});
