import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { JSDOM } from 'jsdom';

test('isAgyAuthRequiredError detects sentinel across raw strings, Error, and wrapped failures', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-agy-runtime-unit-'));
  try {
    const outfile = path.join(directory, 'agy-runtime.cjs');
    await build({
      entryPoints: [path.resolve(import.meta.dirname, '..', 'src', 'lib', 'agy-runtime.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      plugins: [{
        name: 'tauri-stub',
        setup(builder) {
          builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, ({ path: p }) => ({ path: p, namespace: 'stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'export const invoke = async () => null;',
            loader: 'js',
          }));
        },
      }],
    });
    const mod = await import(pathToFileURL(outfile).href);
    assert.equal(mod.isAgyAuthRequiredError('AGY_AUTH_REQUIRED: Antigravity is not signed in.'), true);
    assert.equal(mod.isAgyAuthRequiredError(new Error('AGY_AUTH_REQUIRED: please sign in')), true);
    assert.equal(mod.isAgyAuthRequiredError({ message: 'AGY_AUTH_REQUIRED' }), true);
    assert.equal(mod.isAgyAuthRequiredError('Network timeout'), false);
    assert.equal(mod.isAgyAuthRequiredError(null), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('AgyRuntimeCard displays status, triggers Google login, and saves/resets custom path', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-agy-card-dom-'));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const saved = new Map();
  const MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  };
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    DocumentFragment: dom.window.DocumentFragment,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    MessageChannel,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const calls = [];
  let state = {
    installed: true,
    resolvedPath: '/Users/dev/.local/bin/agy',
    customPath: null,
    defaultHomeDir: '/Users/dev/.gemini/antigravity-cli',
  };
  globalThis.__agyCardTest = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === 'get_agy_runtime_status') return { ...state };
      if (command === 'set_agy_custom_path') {
        if (args.path === '/missing/agy') throw new Error('File does not exist');
        state = {
          ...state,
          customPath: args.path,
          resolvedPath: args.path ?? '/Users/dev/.local/bin/agy',
          installed: true,
        };
        return { ...state };
      }
      if (command === 'login_agent_profile') return undefined;
      return null;
    },
    toasts: [],
  };

  let mounted;
  try {
    const outfile = path.join(directory, 'harness.cjs');
    await build({
      stdin: {
        contents: `import React, { act } from 'react';
          import { createRoot } from 'react-dom/client';
          import { AgyRuntimeCard } from './src/components/AgyRuntimeCard';
          export { act };
          export function mount(container) { const root = createRoot(container); root.render(<AgyRuntimeCard />); return root; }`,
        loader: 'tsx',
        resolveDir: path.resolve(import.meta.dirname, '..'),
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      logLevel: 'silent',
      plugins: [{
        name: 'agy-card-stubs',
        setup(builder) {
          builder.onResolve(
            { filter: /^(@tauri-apps\/api\/core|sonner|@lobehub\/icons|@\/locales|@\/lib\/nativeSurfaceOcclusion|@\/lib\/nativeBrowserOverlay)$/ },
            ({ path: p }) => ({ path: p, namespace: 'fixture' }),
          );
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: p }) => ({
            contents: p === '@lobehub/icons'
              ? 'function Icon(){return null;} Icon.Color = Icon; export const Antigravity = Icon;'
              : p === '@/lib/nativeSurfaceOcclusion'
                ? 'export const useNativeSurfaceOcclusion = open => open;'
                : p === '@/lib/nativeBrowserOverlay'
                  ? 'export const useNativeBrowserOverlayRef = ref => ref;'
                  : p === 'sonner'
                    ? 'export const toast = { success: (t) => globalThis.__agyCardTest.toasts.push(t), error: (t) => globalThis.__agyCardTest.toasts.push(t) };'
                    : p === '@/locales'
                      ? 'export function useLocale() { return { t: (k) => k }; }'
                      : 'export const invoke = (...a) => globalThis.__agyCardTest.invoke(...a);',
            loader: 'js',
          }));
        },
      }],
    });

    const { mount, act } = await import(pathToFileURL(outfile).href);
    const container = dom.window.document.getElementById('root');
    await act(async () => { mounted = mount(container); });

    const card = container.querySelector('[data-testid="agent-profile-agy"]');
    assert.ok(card);
    assert.match(card.textContent, /\/Users\/dev\/\.gemini\/antigravity-cli/);
    assert.match(card.textContent, /\/Users\/dev\/\.local\/bin\/agy/);

    // Trigger Google login
    await act(async () => {
      card.querySelector('[data-testid="agy-login-button"]').click();
    });
    assert.deepEqual(calls.at(-1), { command: 'login_agent_profile', args: { provider: 'agy' } });
    assert.equal(globalThis.__agyCardTest.toasts.at(-1), 'agentProfiles.loginOpened');

    // Open custom path editor & save valid custom path
    await act(async () => {
      card.querySelector('[data-testid="agy-path-toggle"]').click();
    });
    const input = card.querySelector('[data-testid="agy-path-input"]');
    assert.ok(input);
    const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => {
      nativeSetter.call(input, '/opt/custom/bin/agy');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      card.querySelector('[data-testid="agy-path-save"]').click();
    });
    assert.deepEqual(calls.at(-1), { command: 'set_agy_custom_path', args: { path: '/opt/custom/bin/agy' } });
    assert.match(card.textContent, /\/opt\/custom\/bin\/agy/);

    // Reset back to auto-detected path
    await act(async () => {
      card.querySelector('[data-testid="agy-path-toggle"]').click();
    });
    await act(async () => {
      card.querySelector('[data-testid="agy-path-reset"]').click();
    });
    assert.deepEqual(calls.at(-1), { command: 'set_agy_custom_path', args: { path: null } });
    assert.match(card.textContent, /\/Users\/dev\/\.local\/bin\/agy/);

    await act(async () => mounted.unmount());
    mounted = null;
  } finally {
    mounted?.unmount();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.__agyCardTest;
    stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
