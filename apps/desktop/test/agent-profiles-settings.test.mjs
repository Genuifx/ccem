import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { JSDOM } from 'jsdom';

test('Codex defaults to shared state, toggles persist, and failed preparation keeps the current profile', async () => {
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
  let isolated = false;
  let rejectSwitch = true;
  const profiles = () => ['claude', 'codex'].map((provider) => ({
    provider, initialized: true, isolated: provider === 'claude' || isolated,
    directory: provider === 'codex' && !isolated ? '/fixture/official/codex' : `/fixture/ccem/${provider}`,
  }));
  let resolveLogin;
  globalThis.__profileTest = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === 'get_agent_profiles') {
        if (++attempt === 1) throw new Error('Migration temporarily unavailable');
        return profiles();
      }
      if (command === 'set_codex_isolation') {
        if (rejectSwitch) { rejectSwitch = false; throw new Error('Finish active shared sessions before copying'); }
        isolated = args.isolated;
        return profiles();
      }
      return new Promise((resolve) => { resolveLogin = resolve; });
    },
    notifications: [],
    invalidations: 0,
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
        builder.onResolve({ filter: /^(@tauri-apps\/api\/core|sonner|@\/locales|@\/store|@\/features\/conversations\/historyData)$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          contents: path === '@/store'
            ? 'export const useAppStore = { getState: () => ({ setInstalledSkills: (skills) => globalThis.__profileTest.skills = skills }) };'
            : path === '@/features/conversations/historyData'
            ? 'export const invalidateHistoryCache = () => globalThis.__profileTest.invalidations++;'
            : path === 'sonner'
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
    const codexCard = () => container.querySelector('[data-testid="agent-profile-codex"]');
    const toggle = () => container.querySelector('[role="switch"]');
    assert.match(codexCard().textContent, /\/fixture\/official\/codex/);
    assert.equal(toggle().getAttribute('aria-checked'), 'false');
    assert.equal(codexCard().querySelector('button:not([role="switch"])'), null);
    await act(async () => toggle().click());
    assert.match(container.querySelector('[role="alert"]').textContent, /Finish active shared sessions/);
    assert.equal(toggle().getAttribute('aria-checked'), 'false');
    assert.match(codexCard().textContent, /\/fixture\/official\/codex/);
    assert.equal(globalThis.__profileTest.invalidations, 0);
    await act(async () => toggle().click());
    assert.deepEqual(calls.at(-1), { command: 'set_codex_isolation', args: { isolated: true } });
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(toggle().getAttribute('aria-checked'), 'true');
    assert.equal(globalThis.__profileTest.invalidations, 1);
    assert.deepEqual(globalThis.__profileTest.skills, []);
    assert.match(codexCard().textContent, /\/fixture\/ccem\/codex/);
    await act(async () => codexCard().querySelector('button:not([role="switch"])').click());
    assert.deepEqual(calls.at(-1), { command: 'login_agent_profile', args: { provider: 'codex' } });
    assert.ok([...container.querySelectorAll('button')].every((button) => button.disabled));
    await act(async () => { resolveLogin(); });
    assert.ok([...container.querySelectorAll('button')].every((button) => !button.disabled));
    assert.equal(globalThis.__profileTest.notifications.at(-1), 'agentProfiles.loginOpened');
    await act(async () => mounted.unmount());
    await act(async () => { mounted = mount(container); });
    assert.equal(toggle().getAttribute('aria-checked'), 'true');
    await act(async () => toggle().click());
    assert.deepEqual(calls.at(-1), { command: 'set_codex_isolation', args: { isolated: false } });
    assert.equal(toggle().getAttribute('aria-checked'), 'false');
    assert.equal(codexCard().querySelector('button:not([role="switch"])'), null);
    assert.match(codexCard().textContent, /\/fixture\/official\/codex/);
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
