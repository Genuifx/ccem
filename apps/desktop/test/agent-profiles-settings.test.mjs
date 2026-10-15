import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { JSDOM } from 'jsdom';

test('profile settings retries preparation failures and signs in to the selected provider', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-profile-settings-'));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const saved = new Map();
  const MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  };
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, MessageChannel })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const calls = [];
  let attempt = 0;
  let resolveLogin;
  globalThis.__profileTest = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === 'get_agent_profiles') {
        if (++attempt === 1) throw new Error('Migration temporarily unavailable');
        return ['claude', 'codex'].map((provider) => ({ provider, initialized: true, directory: `/fixture/ccem/${provider}` }));
      }
      return new Promise((resolve) => { resolveLogin = resolve; });
    },
    notifications: [],
  };
  let mounted;
  try {
    const outfile = path.join(directory, 'harness.cjs');
    await build({
      stdin: {
        contents: `import React, { act } from 'react';
          import { createRoot } from 'react-dom/client';
          import { AgentProfilesSettings } from './src/components/AgentProfilesSettings';
          export { act };
          export function mount(container) { const root = createRoot(container); root.render(<AgentProfilesSettings />); return root; }`,
        loader: 'tsx', resolveDir: path.resolve(import.meta.dirname, '..'),
      },
      outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
      plugins: [{ name: 'ipc-boundary', setup(builder) {
        builder.onResolve({ filter: /^(@tauri-apps\/api\/core|sonner|@\/locales)$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          contents: path === 'sonner'
            ? 'export const toast = { success: (text) => globalThis.__profileTest.notifications.push(text), error: (text) => globalThis.__profileTest.notifications.push(text) };'
            : path === '@/locales'
              ? 'export function useLocale() { return { t: (key) => key }; }'
              : 'export const invoke = (...args) => globalThis.__profileTest.invoke(...args);',
          loader: 'js',
        }));
      } }],
    });
    const { mount, act } = await import(pathToFileURL(outfile).href);
    const container = dom.window.document.getElementById('root');
    await act(async () => { mounted = mount(container); });
    assert.match(container.querySelector('[role="alert"]').textContent, /Migration temporarily unavailable/);
    await act(async () => container.querySelector('button').click());
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.match(container.textContent, /\/fixture\/ccem\/claude/);
    assert.match(container.textContent, /\/fixture\/ccem\/codex/);
    const buttons = [...container.querySelectorAll('button')];
    await act(async () => buttons[1].click());
    assert.deepEqual(calls.at(-1), { command: 'login_agent_profile', args: { provider: 'codex' } });
    assert.ok(buttons.every((button) => button.disabled));
    await act(async () => { resolveLogin(); });
    assert.ok(buttons.every((button) => !button.disabled));
    assert.equal(globalThis.__profileTest.notifications.at(-1), 'agentProfiles.loginOpened');
    await act(async () => mounted.unmount());
    mounted = null;
  } finally {
    mounted?.unmount();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.__profileTest;
    stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
