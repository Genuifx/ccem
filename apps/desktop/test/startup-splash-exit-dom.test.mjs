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

        export function mount(container) {
          let setExiting;
          let exitCalls = 0;
          function Harness() {
            const [exiting, updateExiting] = useState(false);
            setExiting = updateExiting;
            return (
              <StartupSplash
                exiting={exiting}
                onExitComplete={() => { exitCalls += 1; }}
              />
            );
          }
          const root = createRoot(container);
          act(() => root.render(<Harness />));
          return {
            exit() { act(() => setExiting(true)); },
            exitCalls() { return exitCalls; },
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
