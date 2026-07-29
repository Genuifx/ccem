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
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  for (const filename of INDEX_EXTENSIONS) {
    const candidate = path.join(basePath, filename);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const harnessPlugins = [
  {
    name: 'ccem-session-card-alias',
    setup(builder) {
      builder.onResolve({ filter: /^@\// }, async (args) => {
        if (
          args.path === '@/lib/gsapMotion'
          || args.path === '@/components/ui/tooltip'
          || args.path === '@/components/chat/BindToChatDialog'
        ) {
          return null;
        }
        const resolved = await resolveSourcePath(args.path);
        return resolved
          ? { path: resolved }
          : { errors: [{ text: `Could not resolve ${args.path}` }] };
      });
    },
  },
  {
    name: 'ccem-session-card-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({
        path: 'gsap-motion',
        namespace: 'session-card-test-stub',
      }));
      builder.onResolve({ filter: /^@\/components\/ui\/tooltip$/ }, () => ({
        path: 'tooltip',
        namespace: 'session-card-test-stub',
      }));
      builder.onResolve({ filter: /^\.\.\/history\/ModelIcon$/ }, () => ({
        path: 'model-icon',
        namespace: 'session-card-test-stub',
      }));
      builder.onResolve({ filter: /^\.\/OpenInTerminalPopoverButton$/ }, () => ({
        path: 'terminal-popover',
        namespace: 'session-card-test-stub',
      }));
      builder.onResolve({ filter: /^@\/components\/chat\/BindToChatDialog$/ }, () => ({
        path: 'bind-dialog',
        namespace: 'session-card-test-stub',
      }));
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
        path: 'tauri-core',
        namespace: 'session-card-test-stub',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'session-card-test-stub' }, (args) => {
        if (args.path === 'gsap-motion') {
          return {
            loader: 'js',
            contents: `
              export const ccemMotion = {
                duration: { quick: 0 },
                ease: { standard: 'none' },
              };
              export const gsap = { fromTo() {} };
              export function clearMotionProps() {}
              export function shouldReduceMotion() { return true; }
              export function useGSAP() {}
            `,
          };
        }
        if (args.path === 'model-icon') {
          return { loader: 'jsx', contents: 'export function ModelIcon() { return null; }' };
        }
        if (args.path === 'tooltip') {
          return {
            loader: 'jsx',
            contents: `
              export function TooltipProvider({ children }) { return children; }
              export function Tooltip({ children }) { return children; }
              export function TooltipTrigger({ children }) { return children; }
              export function TooltipContent() { return null; }
            `,
          };
        }
        if (args.path === 'terminal-popover') {
          return {
            loader: 'jsx',
            contents: 'export function OpenInTerminalPopoverButton() { return null; }',
          };
        }
        if (args.path === 'bind-dialog') {
          return { loader: 'jsx', contents: 'export function BindToChatDialog() { return null; }' };
        }
        return {
          loader: 'js',
          contents: `
            export async function invoke(command) {
              if (command === 'get_settings') return { language: 'en' };
              return null;
            }
          `,
        };
      });
    },
  },
];

async function importSessionCardHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-session-card-dom-test-'));
  const outputPath = path.join(tempDir, 'session-card-harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { LocaleProvider } from '@/locales';
        import { SessionCard } from '@/components/sessions/SessionCard';

        const session = {
          id: 'headless-1',
          client: 'opencode',
          envName: 'official',
          workingDir: '/tmp/demo-project',
          startedAt: new Date('2026-07-26T10:00:00.000Z'),
          status: 'running',
          permMode: 'dev',
        };
        const unifiedSession = {
          id: 'headless-1',
          runtimeKind: 'headless',
          source: 'desktop',
          status: 'processing',
          projectDir: '/tmp/demo-project',
          envName: 'official',
          permMode: 'dev',
          createdAt: '2026-07-26T10:00:00.000Z',
          isActive: true,
          client: 'opencode',
          channels: [],
        };

        function ControlledCard({ onRequested, onConfirmed }) {
          const [confirming, setConfirming] = useState(false);
          return (
            <LocaleProvider>
              <SessionCard
                session={session}
                unifiedSession={unifiedSession}
                onFocus={() => {}}
                onOpenInTerminal={() => {}}
                onMinimize={() => {}}
                onClose={(id) => {
                  onRequested(id);
                  setConfirming(true);
                }}
                onStop={() => {}}
                confirmingClose={confirming}
                onCancelClose={() => setConfirming(false)}
                onConfirmClose={onConfirmed}
              />
            </LocaleProvider>
          );
        }

        export function mountSessionCard(container, callbacks) {
          const root = createRoot(container);
          act(() => root.render(<ControlledCard {...callbacks} />));
          return {
            click(element) {
              act(() => element.click());
            },
            pressEscape(element) {
              act(() => {
                element.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'Escape',
                  bubbles: true,
                }));
              });
            },
            unmount() {
              act(() => root.unmount());
            },
          };
        }

        export async function flushEffects() {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'session-card-harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    loader: {
      '.png': 'dataurl',
    },
    plugins: harnessPlugins,
    define: {
      'process.env.NODE_ENV': '"test"',
    },
    logLevel: 'silent',
  });
  return {
    harness: await import(pathToFileURL(outputPath).href),
    tempDir,
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const { window } = dom;
  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => {
          queueMicrotask(() => this.port1.onmessage?.({ data }));
        },
      };
    }
  }
  const names = {
    window,
    self: window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    MessageChannel: TestMessageChannel,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(names)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserver });
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: window.MouseEvent });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserver,
  });
  Object.defineProperty(globalThis, 'PointerEvent', {
    configurable: true,
    writable: true,
    value: window.MouseEvent,
  });

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
      delete globalThis.ResizeObserver;
      delete globalThis.PointerEvent;
    },
  };
}

test('headless card requires confirmation, supports Escape, and restores trigger focus', async () => {
  const { container, restore } = installDom();
  const { harness, tempDir } = await importSessionCardHarness();
  const requested = [];
  const confirmed = [];
  const mounted = harness.mountSessionCard(container, {
    onRequested: (id) => requested.push(id),
    onConfirmed: (id) => confirmed.push(id),
  });

  try {
    await harness.flushEffects();
    let removeButton = container.querySelector('button[aria-label="Remove Task"]');
    assert.ok(removeButton, 'headless remove action should have an accessible name');

    mounted.click(removeButton);
    assert.deepEqual(requested, ['headless-1']);
    assert.deepEqual(confirmed, []);

    const confirmation = container.querySelector('[data-session-confirm-actions]');
    assert.ok(confirmation);
    assert.match(confirmation.textContent, /Terminate this session\?/);
    assert.equal(document.activeElement?.textContent, 'Cancel');

    mounted.pressEscape(document.activeElement);
    assert.equal(container.querySelector('[data-session-confirm-actions]'), null);
    removeButton = container.querySelector('button[aria-label="Remove Task"]');
    assert.equal(document.activeElement, removeButton);

    mounted.click(removeButton);
    const terminateButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Terminate');
    assert.ok(terminateButton);
    mounted.click(terminateButton);
    assert.deepEqual(confirmed, ['headless-1']);
  } finally {
    mounted.unmount();
    restore();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  }
});
