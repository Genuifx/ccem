import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';

const desktopDir = path.resolve(import.meta.dirname, '..');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
const previousGlobals = new Map();
function expose(name, value) {
  previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
for (const name of [
  'window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement',
  'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'CustomEvent', 'KeyboardEvent',
  'MouseEvent', 'MutationObserver', 'NodeFilter', 'DOMRect',
]) expose(name, name === 'window' ? dom.window : dom.window[name]);
expose('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
expose('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
expose('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
expose('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
expose('MessageChannel', class {
  constructor() {
    this.port1 = { onmessage: null };
    this.port2 = { postMessage: (data) => setImmediate(() => this.port1.onmessage?.({ data })) };
  }
});
expose('IS_REACT_ACT_ENVIRONMENT', true);
// Fault injection at the page-code boundary: a cold module request can remain
// pending indefinitely. Keep timers, clicks and the mounted workspace working.
let holdPageImports = false;
let pendingPageImports = 0;
expose('__navigationImport', (load) => {
  if (!holdPageImports) return load();
  pendingPageImports += 1;
  return new Promise(() => {});
});

const pages = {
  Analytics: 'analytics', Environments: 'environments', Skills: 'skills', History: 'history',
  Sessions: 'sessions', CronTasks: 'cron', ProxyDebug: 'proxy-debug', ChatApp: 'chat-app', Settings: 'settings',
};
const stubs = {
  '@tauri-apps/api/core': 'export const invoke = async () => null;',
  '@tauri-apps/api/event': `
    export const handlers = new Map();
    export async function listen(name, callback) {
      handlers.set(name, callback);
      return () => handlers.delete(name);
    }
  `,
  '@/store': `
    const noop = () => {};
    const state = { environments: [], launchClient: 'claude', error: null,
      setEnvironments: noop, setCurrentEnv: noop, setPermissionMode: noop, setDefaultMode: noop,
      setUsageStats: noop, setContinuousUsageDays: noop, setCompanion: noop, setError: noop };
    export const useAppStore = (selector) => selector(state);
    useAppStore.getState = () => state;
  `,
  '@/hooks/useTauriCommands': `
    const noop = async () => {};
    const commands = new Proxy({}, { get: () => noop });
    export const useTauriCommands = () => commands;
  `,
  '@/hooks/useStartup': "export const useStartup = () => ({ ready: true, phase: 'ready' });",
  '@/hooks/useZoom': 'export const useZoom = () => {}; export const readAppZoom = () => 1;',
  '@/hooks/useWebcontentLifecycle': 'export const useWebcontentLifecycle = () => {};',
  '@/lib/webcontentRecovery': `
    export const hasRecoveredWebcontent = () => false;
    export const currentWebcontentDocumentIdentity = () => null;
    export const invokeBrowserCommand = async () => null;
  `,
  '@/lib/idle': 'export const scheduleAfterFirstPaint = () => () => {};',
  '@/lib/gsapMotion': `
    export const useGSAP = () => {};
    export const shouldReduceMotion = () => true;
    export const clearMotionProps = () => {};
    export const gsap = { set() {}, to() {} };
    export const ccemMotion = {};
  `,
  '@/components/NativeBackgroundTaskAppGuard': `
    export const NativeBackgroundTaskAppGuardProvider = ({ children }) => children;
    export const useNativeBackgroundTaskAppGuard = () => ({ requestQuit() {} });
  `,
  '@/components/app-update/AppUpdateProvider': 'export const AppUpdateProvider = ({ children }) => children;',
  '@/components/layout/StartupSplash': 'export const StartupSplash = () => null;',
  '@/components/DeleteEnvConfirmDialog': 'export const DeleteEnvConfirmDialog = () => null;',
  '@/components/EnvironmentDialog': 'export const EnvironmentDialog = () => null;',
  '@/pages/Workspace': `
    import { useState } from 'react';
    export function Workspace({ isActive }) {
      const [events, setEvents] = useState(0);
      return <section data-page="workspace" data-active={isActive}>
        <input aria-label="Workspace draft" defaultValue="unsent draft" />
        <button data-testid="incoming-event" onClick={() => setEvents(n => n + 1)}>{events}</button>
      </section>;
    }
  `,
};
for (const [name, tab] of Object.entries(pages)) {
  // Stub page contents only. The real App, React import timing, navigation,
  // layout, Radix menu, keyboard handling and workspace lifetime are exercised.
  stubs[`@/pages/${name}`] = `
    export const ${name} = () => <section data-page="${tab}">${tab} content</section>;
    export const prime${name}Page = () => {};
  `;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-app-page-navigation-'));
const outputPath = path.join(tempDir, 'harness.cjs');
await build({
  stdin: {
    contents: `
      import React, { act } from 'react';
      import { createRoot } from 'react-dom/client';
      import App from './src/App';
      export { handlers } from '@tauri-apps/api/event';
      export { act };
      export function mount(container) {
        const root = createRoot(container);
        act(() => root.render(<App />));
        return () => act(() => root.unmount());
      }
    `,
    resolveDir: desktopDir, sourcefile: 'harness.tsx', loader: 'tsx',
  },
  outfile: outputPath, bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  jsx: 'automatic', logLevel: 'silent',
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [{
    name: 'app-navigation-services',
    setup(builder) {
      builder.onLoad({ filter: /[/\\]src[/\\]App\.tsx$/ }, async ({ path: file }) => ({
        loader: 'tsx', resolveDir: path.dirname(file),
        contents: (await fs.readFile(file, 'utf8')).replace(
          /import\((['"])@\/pages\/[^'"]+\1\)/g,
          (load) => `globalThis.__navigationImport(() => ${load})`,
        ),
      }));
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (stubs[args.path]) return { path: args.path, namespace: 'stub' };
        if (/MacFullscreenWindowControls$|GlobalUpdateIndicator$/.test(args.path)) {
          return { path: 'native-controls', namespace: 'stub' };
        }
      });
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path: name }) => ({
        loader: 'tsx', resolveDir: desktopDir,
        contents: stubs[name] ?? `
          export const MacFullscreenWindowControls = () => null;
          export const GlobalUpdateIndicator = () => null;
        `,
      }));
      builder.onResolve({ filter: /^@\// }, async (args) => {
        const base = path.join(desktopDir, 'src', args.path.slice(2));
        for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
          const candidate = `${base}${suffix}`;
          if (await fs.stat(candidate).then(stat => stat.isFile()).catch(() => false)) return { path: candidate };
        }
        return { errors: [{ text: `Unresolved desktop import: ${args.path}` }] };
      });
    },
  }],
});
const { mount, act, handlers } = await import(pathToFileURL(outputPath).href);
const query = (selector) => document.querySelector(selector);
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
function assertPage(tab) {
  assert.equal(query('[data-active-tab]')?.dataset.activeTab, tab);
  assert.ok(query(`[data-page="${tab}"]`), `${tab} must render its content`);
  assert.doesNotMatch(document.body.textContent, /Loading\.\.\./, 'navigation must not replace the page with Loading');
}
function click(selector) {
  const button = query(selector);
  assert.ok(button, `click target exists: ${selector}`);
  act(() => button.click());
}
// Global navigation lives behind the same top-left menu on every page.
function navTo(tab) {
  if (!query('[data-testid="workspace-navigation-menu"]')) click('[data-testid="workspace-navigation-trigger"]');
  click(`[data-testid="nav-${tab}"]`);
}
async function start(t) {
  localStorage.clear();
  localStorage.setItem('ccem-sidebar-state', 'expanded');
  const unmount = mount(query('#root'));
  await settle();
  t.after(async () => { holdPageImports = false; unmount(); await settle(); });
}

test.after(async () => {
  stopEsbuild();
  dom.window.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('primary pages remain usable when cold page imports never settle', async (t) => {
  await start(t);
  holdPageImports = true;
  pendingPageImports = 0;
  const draft = query('input');
  draft.value = 'preserve my workspace';
  navTo('settings');

  // A mere first-frame assertion does not distinguish a flash from a hang.
  // Observe the destination after timers continue to run without releasing
  // the module request, then exercise a full workspace/settings round trip.
  await new Promise(resolve => setTimeout(resolve, 1200));
  assertPage('settings');
  assert.equal(pendingPageImports, 0, 'navigation must not depend on a cold page import');
  navTo('workspace');
  assertPage('workspace');
  assert.equal(query('input'), draft);
  assert.equal(draft.value, 'preserve my workspace');
  click('[data-testid="incoming-event"]');
  assert.equal(query('[data-testid="incoming-event"]').textContent, '1');
  navTo('settings');
  assertPage('settings');
  for (const tab of Object.values(pages).filter(tab => tab !== 'settings')) {
    navTo(tab);
    assertPage(tab);
  }
});

test('first clicks render every primary page immediately without needing a hover preload', async (t) => {
  await start(t);
  const draft = query('input');
  draft.value = 'keep this draft';
  for (const tab of ['settings', ...Object.values(pages).filter(tab => tab !== 'settings')]) {
    navTo(tab);
    assertPage(tab); // Deliberately before flushing promises or Suspense retries.
    await settle();
  }
  navTo('workspace');
  assertPage('workspace');
  assert.equal(query('input'), draft);
  assert.equal(draft.value, 'keep this draft');
});

test('repeated settings switches remain immediate while workspace event updates arrive', async (t) => {
  await start(t);
  for (let i = 0; i < 5; i += 1) {
    click('[data-testid="incoming-event"]');
    navTo('settings');
    assertPage('settings');
    click('[data-testid="incoming-event"]');
    assertPage('settings');
    navTo('workspace');
    assertPage('workspace');
    await settle();
  }
  assert.equal(query('[data-testid="incoming-event"]').textContent, '10');
});

test('keyboard and native menu navigation render without hover or asynchronous page retries', async (t) => {
  await start(t);
  act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true })));
  assertPage('settings');
  for (const tab of ['skills', 'cron', 'chat-app', 'proxy-debug', 'workspace', 'settings']) {
    assert.ok(handlers.has('tray-open-tab'));
    act(() => handlers.get('tray-open-tab')({ payload: { tab } }));
    assertPage(tab);
  }
});
