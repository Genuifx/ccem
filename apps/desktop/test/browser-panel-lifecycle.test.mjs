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
const bridgeKey = '__CCEM_BROWSER_PANEL_LIFECYCLE_TEST__';
const sourceExtensions = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
const indexExtensions = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.json'];

async function resolveDesktopSource(importPath) {
  const basePath = path.join(desktopDir, 'src', importPath.slice(2));
  for (const extension of sourceExtensions) {
    const candidate = `${basePath}${extension}`;
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next source extension.
    }
  }
  for (const filename of indexExtensions) {
    const candidate = path.join(basePath, filename);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next index filename.
    }
  }
  return null;
}

const browserPanelTestStubs = {
  name: 'ccem-browser-panel-lifecycle-stubs',
  setup(builder) {
    const virtual = (filter, pathName) => {
      builder.onResolve({ filter }, () => ({
        path: pathName,
        namespace: 'browser-panel-lifecycle-test',
      }));
    };

    virtual(/^@tauri-apps\/api\/core$/, 'tauri-core');
    virtual(/^@tauri-apps\/api\/event$/, 'tauri-event');
    virtual(/^@tauri-apps\/plugin-shell$/, 'tauri-shell');
    virtual(/^sonner$/, 'sonner');
    virtual(/^@\/locales$/, 'locales');
    virtual(/^@\/hooks\/useNativeBrowserSurfaceGeometrySync$/, 'geometry-sync');
    virtual(/^@\/hooks\/useZoom$/, 'zoom');
    virtual(/^@\/lib\/lucide-react$/, 'icons');
    virtual(/^@\/components\/ui\/button$/, 'button');
    virtual(/^@\/components\/ui\/input$/, 'input');
    virtual(/^@\/components\/ui\/popover$/, 'popover');
    virtual(/^@\/components\/ui\/tooltip$/, 'tooltip');

    builder.onLoad(
      { filter: /.*/, namespace: 'browser-panel-lifecycle-test' },
      (args) => {
        const modules = {
          'tauri-core': `
            export function invoke(command, args) {
              return globalThis.${bridgeKey}.invoke(command, args);
            }
          `,
          'tauri-event': `
            export function listen(eventName, handler) {
              return globalThis.${bridgeKey}.listen(eventName, handler);
            }
          `,
          'tauri-shell': `
            export function open(url) {
              return globalThis.${bridgeKey}.openExternal(url);
            }
          `,
          sonner: `
            export const toast = {
              success(message) {
                globalThis.${bridgeKey}.toasts.push({ kind: 'success', message });
              },
              error(message) {
                globalThis.${bridgeKey}.toasts.push({ kind: 'error', message });
              },
            };
          `,
          locales: `
            export function useLocale() {
              return { t: globalThis.${bridgeKey}.translate };
            }
          `,
          'geometry-sync': `
            export function useNativeBrowserSurfaceGeometrySync() {}
          `,
          zoom: `
            export const CCEM_ZOOM_STORAGE_KEY = 'ccem.test.zoom';
          `,
          icons: `
            const icon = (name) => function TestIcon(props) {
              const React = globalThis.${bridgeKey}.React;
              return React.createElement('span', { ...props, 'data-icon': name });
            };
            export const ArrowLeft = icon('ArrowLeft');
            export const ArrowRight = icon('ArrowRight');
            export const Bot = icon('Bot');
            export const Copy = icon('Copy');
            export const ExternalLink = icon('ExternalLink');
            export const FileImage = icon('FileImage');
            export const FileJson = icon('FileJson');
            export const Files = icon('Files');
            export const Globe = icon('Globe');
            export const LoaderCircle = icon('LoaderCircle');
            export const PanelTopClose = icon('PanelTopClose');
            export const Pause = icon('Pause');
            export const Play = icon('Play');
            export const RefreshCw = icon('RefreshCw');
            export const ScrollText = icon('ScrollText');
            export const ShieldCheck = icon('ShieldCheck');
            export const Square = icon('Square');
            export const UserRound = icon('UserRound');
            export const X = icon('X');
          `,
          button: `
            export function Button({ asChild, children, ...props }) {
              const React = globalThis.${bridgeKey}.React;
              return React.createElement('button', props, children);
            }
          `,
          input: `
            export function Input(props) {
              const React = globalThis.${bridgeKey}.React;
              return React.createElement('input', props);
            }
          `,
          popover: `
            export function Popover({ children }) { return children; }
            export function PopoverTrigger({ children }) { return children; }
            export function PopoverContent() { return null; }
          `,
          tooltip: `
            export function Tooltip({ children }) { return children; }
            export function TooltipTrigger({ children }) { return children; }
            export function TooltipContent({ children }) {
              const React = globalThis.${bridgeKey}.React;
              return React.createElement('span', { 'data-tooltip-content': 'true' }, children);
            }
          `,
        };
        return {
          loader: 'js',
          contents: modules[args.path],
        };
      },
    );
  },
};

const desktopAliasPlugin = {
  name: 'ccem-browser-panel-lifecycle-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = await resolveDesktopSource(args.path);
      if (!resolved) {
        return { errors: [{ text: `Could not resolve ${args.path}` }] };
      }
      return { path: resolved };
    });
  },
};

async function importBrowserPanelHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-browser-panel-lifecycle-'));
  const outputPath = path.join(tempDir, 'browser-panel-lifecycle-harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { BrowserPanel } from '@/components/workspace/BrowserPanel';
        import { nativeSurfaceOcclusionStore } from '@/lib/nativeSurfaceOcclusionStore';

        const translators = {
          zh: (key) => 'zh:' + key,
          en: (key) => 'en:' + key,
        };

        export function mountBrowserPanel(container, initialProps, options = {}) {
          const root = createRoot(container);
          globalThis.${bridgeKey}.React = React;
          const render = (nextProps) => {
            const { locale, ...panelProps } = nextProps;
            globalThis.${bridgeKey}.translate = translators[locale];
            act(() => {
              const panel = <BrowserPanel {...panelProps} />;
              root.render(options.strictMode ? <React.StrictMode>{panel}</React.StrictMode> : panel);
            });
          };
          render(initialProps);
          return {
            render,
            unmount() {
              act(() => root.unmount());
            },
          };
        }

        export async function flushEffects() {
          await act(async () => {
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await Promise.resolve();
          });
        }

        export function click(element) {
          act(() => element.click());
        }

        export function changeInput(element, value) {
          act(() => {
            const setter = Object.getOwnPropertyDescriptor(
              element.ownerDocument.defaultView.HTMLInputElement.prototype,
              'value',
            ).set;
            setter.call(element, value);
            element.dispatchEvent(new element.ownerDocument.defaultView.Event('input', { bubbles: true }));
          });
        }

        export function submit(form) {
          act(() => form.dispatchEvent(new form.ownerDocument.defaultView.Event('submit', {
            bubbles: true,
            cancelable: true,
          })));
        }

        export function emitBrowserState(bridge, leaseId, generation, snapshot) {
          act(() => bridge.emitBrowserState(leaseId, generation, snapshot));
        }

        export async function acquireNativeSurfaceOcclusion() {
          let lease;
          await act(async () => {
            lease = nativeSurfaceOcclusionStore.acquire();
            await lease.ready;
          });
          return {
            async release() {
              await act(async () => lease.release());
            },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'browser-panel-lifecycle-harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [browserPanelTestStubs, desktopAliasPlugin],
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
  const expose = (name, value) => {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  const requestAnimationFrame = (callback) => {
    const handle = setTimeout(() => callback(Date.now()), 0);
    return handle;
  };
  const cancelAnimationFrame = (handle) => clearTimeout(handle);
  class TestMessageChannel {
    constructor() {
      this.port1 = {
        onmessage: null,
        close() {},
        start() {},
        unref() {},
      };
      this.port2 = {
        close() {},
        start() {},
        unref() {},
        postMessage: (data) => {
          queueMicrotask(() => this.port1.onmessage?.({ data }));
        },
      };
    }
  }

  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('localStorage', window.localStorage);
  expose('Node', window.Node);
  expose('Element', window.Element);
  expose('HTMLElement', window.HTMLElement);
  expose('Event', window.Event);
  expose('CustomEvent', window.CustomEvent);
  expose('DOMRect', window.DOMRect);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('requestAnimationFrame', requestAnimationFrame);
  expose('cancelAnimationFrame', cancelAnimationFrame);
  expose('MessageChannel', TestMessageChannel);
  expose('IS_REACT_ACT_ENVIRONMENT', true);

  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: requestAnimationFrame,
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: cancelAnimationFrame,
  });
  Object.defineProperty(window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return new window.DOMRect(0, 0, 720, 480);
    },
  });

  return dom;
}

function createBridge({
  acquireSnapshot = {},
  acquireSnapshots = null,
  acquireSurfaceIds = null,
  navigationActionSnapshots = {},
  syncGate = null,
} = {}) {
  let loginGeneration = 0;
  let loginServerSequence = 100;
  const loginControls = new Map();
  const calls = [];
  const listeners = new Map();
  const bridge = {
    calls,
    toasts: [],
    translate: (key) => `zh:${key}`,
    async listen(eventName, handler) {
      calls.push({ command: `listen:${eventName}`, args: { handler } });
      const eventListeners = listeners.get(eventName) ?? new Set();
      eventListeners.add(handler);
      listeners.set(eventName, eventListeners);
      return () => eventListeners.delete(handler);
    },
    emitBrowserState(leaseId, generation, snapshot) {
      if (snapshot.control !== undefined) loginControls.set(leaseId, snapshot.control);
      const payload = {
        lease_id: leaseId,
        generation,
        client_revision: 0,
        server_sequence: ++loginServerSequence,
        backend: 'login',
        cause: 'test',
        snapshot,
      };
      for (const handler of listeners.get('browser_surface_state_changed') ?? []) {
        handler({ payload });
      }
    },
    async openExternal(url) {
      calls.push({ command: 'open_external', args: { url } });
    },
    async invoke(command, args = {}) {
      calls.push({ command, args });
      switch (command) {
        case 'browser_surface_acquire': {
          loginGeneration += 1;
          const indexedAcquireSnapshot = acquireSnapshots?.[loginGeneration - 1]
            ?? acquireSnapshot;
          const snapshot = {
            url: args.initialUrl ?? null,
            title: 'Login',
            visible: false,
            loading: false,
            error: null,
            lifecycle: 'ready',
            control: 'user',
            auto_handoff: true,
            paused: false,
            profile_id: 'shared-profile',
            session_status: 'running',
            recovery_states: [],
            popup_active: false,
            popup_url: null,
            popup_title: null,
            popup_loading: false,
            popup_error: null,
            ...indexedAcquireSnapshot,
          };
          loginControls.set(`lease-${loginGeneration}`, snapshot.control);
          return {
            lease_id: `lease-${loginGeneration}`,
            generation: loginGeneration,
            surface_id: acquireSurfaceIds?.[loginGeneration - 1]
              ?? `surface-${loginGeneration}`,
            client_revision: args.clientRevision,
            server_sequence: loginGeneration,
            backend: 'login',
            profile_id: 'shared-profile',
            snapshot,
          };
        }
        case 'browser_surface_sync':
          if (syncGate) await syncGate;
          return undefined;
        case 'browser_surface_release':
        case 'browser_surface_navigate':
          return undefined;
        case 'browser_surface_navigation_action':
          return {
            lease_id: args.leaseId,
            generation: args.generation,
            server_sequence: ++loginServerSequence,
            snapshot: {
              lifecycle: 'ready',
              loading: false,
              session_status: 'running',
              popup_active: false,
              ...(navigationActionSnapshots[args.action] ?? {}),
            },
          };
        case 'browser_surface_control': {
          const previousControl = loginControls.get(args.leaseId) ?? 'user';
          const nextControl = args.action === 'handoff'
            ? 'agent'
            : args.action === 'takeover'
              ? 'user'
              : args.action === 'occlude' && previousControl === 'agent'
                ? 'paused'
                : previousControl;
          loginControls.set(args.leaseId, nextControl);
          const responseSequence = ++loginServerSequence;
          return {
            lease_id: args.leaseId,
            generation: args.generation,
            server_sequence: responseSequence,
            snapshot: {
              lifecycle: 'ready',
              control: nextControl,
              auto_handoff: args.action === 'handoff'
                ? true
                : args.action === 'takeover'
                  ? false
                  : undefined,
              paused: nextControl === 'paused',
              session_status: 'running',
              recovery_states: [],
              popup_active: false,
            },
          };
        }
        default:
          throw new Error(`Unexpected BrowserPanel command: ${command}`);
      }
    },
  };
  Object.defineProperty(globalThis, bridgeKey, {
    configurable: true,
    writable: true,
    value: bridge,
  });
  return bridge;
}

function callsFor(bridge, command) {
  return bridge.calls.filter((call) => call.command === command);
}

test('Login locale changes retain its lease until the panel actually unmounts', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const initialProps = {
    locale: 'zh',
    backend: 'login',
    sessionId: 'runtime:a:2',
    defaultUrl: 'https://accounts.example.test',
    presentationRevision: 10,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  };
  mounted = harness.mountBrowserPanel(container, initialProps);
  await harness.flushEffects();
  await harness.flushEffects();
  assert.equal(callsFor(bridge, 'browser_surface_acquire').length, 1);
  assert.equal(callsFor(bridge, 'browser_surface_release').length, 0);
  for (const key of ['browserBack', 'browserForward', 'browserReload']) {
    assert.ok(container.querySelector(`button[aria-label="zh:workspace.${key}"]`));
    assert.ok([...container.querySelectorAll('[data-tooltip-content="true"]')]
      .some((tooltip) => tooltip.textContent === `zh:workspace.${key}`));
  }

  mounted.render({
    ...initialProps,
    locale: 'en',
  });
  await harness.flushEffects();
  await harness.flushEffects();

  assert.equal(
    callsFor(bridge, 'browser_surface_acquire').length,
    1,
    'changing the translator identity must not reacquire Login',
  );
  assert.equal(
    callsFor(bridge, 'browser_surface_release').length,
    0,
    'changing the translator identity must not close Login',
  );
  for (const key of ['browserBack', 'browserForward', 'browserReload']) {
    assert.ok(container.querySelector(`button[aria-label="en:workspace.${key}"]`));
    assert.ok([...container.querySelectorAll('[data-tooltip-content="true"]')]
      .some((tooltip) => tooltip.textContent === `en:workspace.${key}`));
  }

  mounted.unmount();
  mounted = null;
  await harness.flushEffects();
  const releases = callsFor(bridge, 'browser_surface_release');
  assert.equal(releases.length, 1, 'real unmount must close the exact Login lease');
  assert.equal(releases[0].args.disposition, 'close');
});

test('browser action failures toast without replacing the page with an inline error', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const invoke = bridge.invoke.bind(bridge);
  bridge.invoke = async (command, args) => {
    if (command === 'browser_surface_navigation_action') {
      throw new Error('reload failed');
    }
    return invoke(command, args);
  };
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:action-error:browser:1',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  await harness.flushEffects();

  const reload = container.querySelector('button[aria-label="zh:workspace.browserReload"]');
  assert.ok(reload);
  harness.click(reload);
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(bridge.toasts, [{ kind: 'error', message: 'Error: reload failed' }]);
  assert.doesNotMatch(container.textContent, /reload failed/);
});

test('acquire failures stay inline and do not duplicate as a toast', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:acquire-error:browser:1',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();

  assert.match(container.textContent, /zh:workspace\.browserSurfaceUnavailable/);
  assert.deepEqual(bridge.toasts, []);
  assert.equal(callsFor(bridge, 'browser_surface_acquire').length, 0);
});

test('a fresh snapshot clears omitted recovery state and its derived inline error', async (t) => {
  const dom = installDom();
  const bridge = createBridge({
    acquireSnapshot: { recovery_states: ['renderer_process_terminated'] },
  });
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:recovery-cleared:browser:1',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  await harness.flushEffects();

  const panel = container.querySelector('[data-ccem-browser-panel="true"]');
  assert.ok(panel);
  assert.equal(panel.getAttribute('data-ccem-browser-recovery'), 'renderer_process_terminated');
  assert.match(container.textContent, /zh:workspace\.browserRecoveryRendererStopped/);

  harness.emitBrowserState(bridge, 'lease-1', 1, { lifecycle: 'ready' });
  await harness.flushEffects();

  assert.equal(panel.getAttribute('data-ccem-browser-recovery'), 'none');
  assert.doesNotMatch(container.textContent, /zh:workspace\.browserRecoveryRendererStopped/);
});

test('address bar navigation actions use exact lease state and authoritative capabilities', async (t) => {
  const dom = installDom();
  const bridge = createBridge({
    acquireSnapshot: {
      url: null,
      can_go_back: false,
      can_go_forward: false,
    },
    navigationActionSnapshots: {
      back: {
        url: 'https://accounts.example.test/start',
        can_go_back: false,
        can_go_forward: true,
      },
      forward: {
        url: 'https://accounts.example.test/next',
        can_go_back: true,
        can_go_forward: false,
      },
      reload: {
        url: 'https://accounts.example.test/next',
        can_go_back: true,
        can_go_forward: false,
      },
    },
  });
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:navigation:browser:1',
    defaultUrl: 'https://accounts.example.test/next',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  await harness.flushEffects();

  const navigation = container.querySelector('[data-ccem-browser-navigation="true"]');
  assert.ok(navigation);
  assert.deepEqual(
    [...navigation.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
    [
      'zh:workspace.browserBack',
      'zh:workspace.browserForward',
      'zh:workspace.browserReload',
      'zh:workspace.browserOpenExternal',
      'zh:workspace.browserUrl',
      'zh:loginBrowserControl.handoffAgent',
    ],
    'browser navigation controls must precede External, URL, and the single Agent toggle',
  );

  const button = (key) => navigation.querySelector(`button[aria-label="zh:workspace.${key}"]`);
  assert.equal(button('browserBack')?.disabled, true);
  assert.equal(button('browserForward')?.disabled, true);
  assert.equal(button('browserReload')?.disabled, false);
  harness.click(button('browserBack'));
  harness.click(button('browserForward'));
  assert.equal(callsFor(bridge, 'browser_surface_navigation_action').length, 0);

  harness.emitBrowserState(bridge, 'lease-1', 1, {
    control: 'agent',
    can_go_back: true,
    can_go_forward: true,
  });
  await harness.flushEffects();
  assert.equal(button('browserBack')?.disabled, true);
  assert.equal(button('browserForward')?.disabled, true);
  assert.equal(button('browserReload')?.disabled, true);
  const urlDisplay = navigation.querySelector('[data-ccem-browser-url-display="true"]');
  assert.ok(urlDisplay);
  assert.equal(urlDisplay.disabled, true, 'manual URL navigation requires User control');
  harness.click(button('browserReload'));
  harness.click(urlDisplay);
  assert.equal(callsFor(bridge, 'browser_surface_navigation_action').length, 0);
  assert.equal(navigation.querySelector('[data-ccem-browser-url-input="true"]'), null);

  harness.emitBrowserState(bridge, 'lease-1', 1, {
    control: 'user',
    can_go_back: true,
    can_go_forward: true,
  });
  await harness.flushEffects();
  assert.equal(button('browserBack')?.disabled, false);
  assert.equal(button('browserForward')?.disabled, false);

  harness.click(button('browserBack'));
  harness.click(button('browserBack'));
  assert.equal(button('browserBack')?.disabled, true, 'busy state disables Back immediately');
  assert.equal(button('browserForward')?.disabled, true, 'busy state disables Forward immediately');
  assert.equal(button('browserReload')?.disabled, true, 'busy state disables Reload immediately');
  await harness.flushEffects();
  await harness.flushEffects();
  assert.equal(button('browserBack')?.disabled, true);
  assert.equal(button('browserForward')?.disabled, false);

  harness.click(button('browserForward'));
  await harness.flushEffects();
  await harness.flushEffects();
  assert.equal(button('browserBack')?.disabled, false);
  assert.equal(button('browserForward')?.disabled, true);

  harness.click(button('browserReload'));
  await harness.flushEffects();
  await harness.flushEffects();

  const actionCalls = callsFor(bridge, 'browser_surface_navigation_action');
  assert.deepEqual(
    actionCalls.map(({ args }) => ({
      leaseId: args.leaseId,
      generation: args.generation,
      action: args.action,
    })),
    [
      { leaseId: 'lease-1', generation: 1, action: 'back' },
      { leaseId: 'lease-1', generation: 1, action: 'forward' },
      { leaseId: 'lease-1', generation: 1, action: 'reload' },
    ],
  );
  assert.ok(actionCalls.every(({ args }, index) => (
    index === 0 || args.clientRevision > actionCalls[index - 1].args.clientRevision
  )), 'navigation actions must retain monotonically increasing client revisions');

  const assertHistoryDisabled = () => {
    assert.equal(button('browserBack')?.disabled, true);
    assert.equal(button('browserForward')?.disabled, true);
  };
  harness.emitBrowserState(bridge, 'lease-1', 1, { lifecycle: 'ready', loading: true });
  await harness.flushEffects();
  assertHistoryDisabled();
  assert.equal(button('browserReload'), null);
  assert.equal(
    button('browserStopLoading')?.disabled,
    true,
    'Stop stays disabled until native lifecycle and loading state both agree',
  );
  harness.emitBrowserState(bridge, 'lease-1', 1, { lifecycle: 'loading', loading: true });
  await harness.flushEffects();
  const stop = button('browserStopLoading');
  assert.ok(stop);
  assert.equal(stop.disabled, false);
  assert.ok([...navigation.querySelectorAll('[data-tooltip-content="true"]')]
    .some((tooltip) => tooltip.textContent === 'zh:workspace.browserStopLoading'));
  harness.click(stop);
  assert.equal(stop.disabled, true, 'busy state disables Stop immediately');
  await harness.flushEffects();
  await harness.flushEffects();
  assert.equal(button('browserStopLoading'), null);
  assert.equal(button('browserReload')?.disabled, false);
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_navigation_action').map(({ args }) => args.action),
    ['back', 'forward', 'reload', 'stop'],
  );

  harness.emitBrowserState(bridge, 'lease-1', 1, { loading: false, lifecycle: 'loading' });
  await harness.flushEffects();
  assertHistoryDisabled();
  assert.equal(button('browserReload')?.disabled, true);
  harness.emitBrowserState(bridge, 'lease-1', 1, {
    lifecycle: 'ready',
    popup_active: true,
  });
  await harness.flushEffects();
  assertHistoryDisabled();
  assert.equal(button('browserReload')?.disabled, true);
  harness.emitBrowserState(bridge, 'lease-1', 1, {
    popup_active: false,
    session_status: 'closing',
  });
  await harness.flushEffects();
  assertHistoryDisabled();
  assert.equal(button('browserReload')?.disabled, true);
  harness.click(button('browserReload'));
  assert.equal(callsFor(bridge, 'browser_surface_navigation_action').length, 4);
});

test('a queued navigation action silently supersedes after its surface becomes inactive', async (t) => {
  const dom = installDom();
  let releaseSync;
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const bridge = createBridge({
    acquireSnapshot: { can_go_back: true, can_go_forward: true },
    syncGate,
  });
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    releaseSync?.();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const props = {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:navigation-race:browser:1',
    defaultUrl: 'https://accounts.example.test',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  };
  mounted = harness.mountBrowserPanel(container, props);
  await harness.flushEffects();
  assert.ok(callsFor(bridge, 'browser_surface_sync').length >= 1);

  const back = container.querySelector('button[aria-label="zh:workspace.browserBack"]');
  assert.ok(back);
  assert.equal(back.disabled, false);
  harness.click(back);
  mounted.render({
    ...props,
    isActiveSurface: false,
    surfaceOccluded: true,
    presentationRevision: 2,
  });
  await harness.flushEffects();
  releaseSync();
  await harness.flushEffects();
  await harness.flushEffects();

  assert.equal(
    callsFor(bridge, 'browser_surface_navigation_action').length,
    0,
    'the queued action must revalidate current active and occlusion state before invoking IPC',
  );
  assert.deepEqual(bridge.toasts, [], 'superseded navigation must remain silent');
});

test('a queued navigation action silently supersedes when the page starts loading', async (t) => {
  const dom = installDom();
  let releaseSync;
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const bridge = createBridge({
    acquireSnapshot: { can_go_back: true, can_go_forward: true },
    syncGate,
  });
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    releaseSync?.();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:navigation-loading-race:browser:1',
    defaultUrl: 'https://accounts.example.test',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();

  const back = container.querySelector('button[aria-label="zh:workspace.browserBack"]');
  assert.ok(back);
  assert.equal(back.disabled, false);
  harness.click(back);
  harness.emitBrowserState(bridge, 'lease-1', 1, {
    lifecycle: 'loading',
    loading: true,
  });
  await harness.flushEffects();
  releaseSync();
  await harness.flushEffects();
  await harness.flushEffects();

  assert.equal(
    callsFor(bridge, 'browser_surface_navigation_action').length,
    0,
    'a queued action must revalidate authoritative loading state before invoking IPC',
  );
  assert.deepEqual(bridge.toasts, [], 'loading-state supersede must remain silent');
});

test('a queued Stop silently supersedes after loading has already finished', async (t) => {
  const dom = installDom();
  let releaseSync;
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const bridge = createBridge({
    acquireSnapshot: { lifecycle: 'loading', loading: true },
    syncGate,
  });
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    releaseSync?.();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:stop-loading-race:browser:1',
    defaultUrl: 'https://accounts.example.test',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();

  const stop = container.querySelector(
    'button[aria-label="zh:workspace.browserStopLoading"]',
  );
  assert.ok(stop);
  assert.equal(stop.disabled, false);
  harness.click(stop);
  harness.emitBrowserState(bridge, 'lease-1', 1, {
    lifecycle: 'ready',
    loading: false,
  });
  await harness.flushEffects();
  releaseSync();
  await harness.flushEffects();
  await harness.flushEffects();

  assert.equal(
    callsFor(bridge, 'browser_surface_navigation_action').length,
    0,
    'queued Stop must revalidate that this exact lease is still loading',
  );
  assert.deepEqual(bridge.toasts, []);
});

test('a superseded queued URL keeps the newer authoritative browser URL', async (t) => {
  const dom = installDom();
  let releaseSync;
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const bridge = createBridge({
    acquireSnapshot: { url: 'https://accounts.example.test/a' },
    syncGate,
  });
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    releaseSync?.();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:url-race:browser:1',
    defaultUrl: 'https://accounts.example.test/a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();

  const display = container.querySelector('[data-ccem-browser-url-display="true"]');
  assert.ok(display);
  harness.click(display);
  const input = container.querySelector('[data-ccem-browser-url-input="true"]');
  assert.ok(input);
  harness.changeInput(input, 'https://accounts.example.test/c');
  harness.submit(input.closest('form'));

  harness.emitBrowserState(bridge, 'lease-1', 1, {
    url: 'https://accounts.example.test/b',
    lifecycle: 'loading',
    loading: true,
  });
  await harness.flushEffects();
  releaseSync();
  await harness.flushEffects();
  await harness.flushEffects();

  assert.equal(callsFor(bridge, 'browser_surface_navigate').length, 0);
  assert.equal(
    container.querySelector('[data-ccem-browser-url-display="true"]')?.textContent,
    'https://accounts.example.test/b',
  );
  assert.deepEqual(bridge.toasts, []);
});

test('Login A and B default to their exact Agent once per lease, retain leases across A-to-B-to-A, and close exactly A', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const { harness, tempDir } = await importBrowserPanelHarness();
  const root = document.querySelector('#root');
  assert.ok(root);
  const containerA = document.createElement('div');
  const containerB = document.createElement('div');
  containerA.dataset.owner = 'a';
  containerB.dataset.owner = 'b';
  root.append(containerA, containerB);
  const closed = [];
  let mountedA;
  let mountedB;

  t.after(async () => {
    mountedA?.unmount();
    mountedB?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const propsA = {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:a:browser:1',
    agentSessionId: 'runtime-a',
    defaultUrl: 'https://accounts.example.test/a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose: () => closed.push('a'),
  };
  const propsB = {
    ...propsA,
    sessionId: 'conversation:b:browser:1',
    agentSessionId: undefined,
    defaultUrl: 'https://accounts.example.test/b',
    isActiveSurface: false,
    onClose: () => closed.push('b'),
  };

  mountedA = harness.mountBrowserPanel(containerA, propsA);
  mountedB = harness.mountBrowserPanel(containerB, propsB);
  await harness.flushEffects();
  await harness.flushEffects();

  const acquireCalls = callsFor(bridge, 'browser_surface_acquire');
  assert.equal(acquireCalls.length, 2);
  const leaseA = acquireCalls.find((call) => (
    call.args.panelSessionId === propsA.sessionId
  ))?.args;
  const leaseB = acquireCalls.find((call) => (
    call.args.panelSessionId === propsB.sessionId
  ))?.args;
  assert.ok(leaseA);
  assert.ok(leaseB);
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => ({
      leaseId: args.leaseId,
      action: args.action,
      agentSessionId: args.agentSessionId,
    })),
    [{ leaseId: 'lease-1', action: 'handoff', agentSessionId: 'runtime-a' }],
    'a new ready lease with an exact runtime must hand off without another user gesture',
  );

  mountedA.render({
    ...propsA,
    agentSessionId: undefined,
    isActiveSurface: false,
    presentationRevision: 2,
  });
  mountedB.render({
    ...propsB,
    agentSessionId: 'runtime-b',
    isActiveSurface: true,
    presentationRevision: 2,
  });
  await harness.flushEffects();
  await harness.flushEffects();

  mountedA.render({ ...propsA, isActiveSurface: true, presentationRevision: 3 });
  mountedB.render({
    ...propsB,
    agentSessionId: undefined,
    isActiveSurface: false,
    presentationRevision: 3,
  });
  await harness.flushEffects();

  const controls = callsFor(bridge, 'browser_surface_control');
  assert.deepEqual(
    controls.map(({ args }) => ({
      leaseId: args.leaseId,
      action: args.action,
      agentSessionId: args.agentSessionId,
    })),
    [
      { leaseId: 'lease-1', action: 'handoff', agentSessionId: 'runtime-a' },
      { leaseId: 'lease-2', action: 'handoff', agentSessionId: 'runtime-b' },
    ],
  );
  assert.equal(
    callsFor(bridge, 'browser_surface_acquire').length,
    2,
    'A-to-B-to-A must not reacquire either retained Login instance',
  );
  assert.equal(
    callsFor(bridge, 'browser_surface_release').length,
    0,
    'visibility switching must not release either retained Login instance',
  );

  harness.click(containerA.querySelector(
    'button[aria-label="zh:loginBrowserControl.closeBrowser"]',
  ));
  await harness.flushEffects();
  assert.deepEqual(closed, ['a']);
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_release').map(({ args }) => ({
      leaseId: args.leaseId,
      disposition: args.disposition,
    })),
    [{ leaseId: 'lease-1', disposition: 'close' }],
    'closing A must release only A while B remains retained',
  );
  mountedA.unmount();
  mountedA = null;
  await harness.flushEffects();
  assert.equal(
    callsFor(bridge, 'browser_surface_release').length,
    1,
    'Workspace removal after a successful close must not release A twice',
  );
  assert.ok(containerB.querySelector(
    '[data-ccem-browser-navigation="true"] button[aria-label="zh:loginBrowserControl.takeover"]',
  ));
  assert.equal(
    containerB.querySelector('[data-ccem-browser-tab-strip="true"] [data-ccem-browser-control-toggle="true"]'),
    null,
    'handoff, pause, and takeover controls must not remain in the tab strip',
  );
});

test('Agent control is one address-bar toggle and takeover does not re-handoff the same lease', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const props = {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:agent-default:browser:1',
    agentSessionId: 'runtime-a',
    defaultUrl: 'https://accounts.example.test',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  };
  mounted = harness.mountBrowserPanel(container, props);
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['handoff'],
  );
  const navigation = container.querySelector('[data-ccem-browser-navigation="true"]');
  const tabStrip = container.querySelector('[data-ccem-browser-tab-strip="true"]');
  assert.ok(navigation);
  assert.ok(tabStrip);
  const takeover = navigation.querySelector(
    'button[aria-label="zh:loginBrowserControl.takeover"]',
  );
  assert.ok(takeover);
  assert.equal(
    navigation.querySelectorAll('[data-ccem-browser-control-toggle="true"]').length,
    1,
    'the address bar exposes one control toggle',
  );
  assert.equal(tabStrip.querySelector(
    'button[aria-label="zh:loginBrowserControl.pauseAgent"]',
  ), null);
  assert.equal(tabStrip.querySelector(
    'button[aria-label="zh:loginBrowserControl.takeover"]',
  ), null);

  harness.click(takeover);
  await harness.flushEffects();
  await harness.flushEffects();
  mounted.render({ ...props, presentationRevision: 2 });
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['handoff', 'takeover'],
    'taking over must not let a render or control-state update auto-handoff the same lease again',
  );
  const handoff = navigation.querySelector(
    'button[aria-label="zh:loginBrowserControl.handoffAgent"]',
  );
  assert.ok(handoff);
  assert.equal(handoff.disabled, false);

  harness.emitBrowserState(bridge, 'lease-1', 1, {
    lifecycle: 'loading',
    loading: true,
  });
  await harness.flushEffects();
  assert.equal(handoff.disabled, true, 'handoff waits for authoritative Ready state');
  harness.emitBrowserState(bridge, 'lease-1', 1, {
    lifecycle: 'ready',
    loading: false,
  });
  await harness.flushEffects();
  assert.equal(handoff.disabled, false);

  mounted.render({
    ...props,
    presentationRevision: 3,
    isActiveSurface: false,
    surfaceOccluded: true,
  });
  await harness.flushEffects();
  assert.equal(handoff.disabled, true, 'an inactive hidden surface exposes no control action');
  mounted.render({ ...props, presentationRevision: 4 });
  await harness.flushEffects();
  assert.equal(handoff.disabled, false);

  mounted.render({
    ...props,
    sessionId: 'conversation:agent-default:browser:2',
    presentationRevision: 5,
  });
  await harness.flushEffects();
  await harness.flushEffects();
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => ({
      leaseId: args.leaseId,
      action: args.action,
    })),
    [
      { leaseId: 'lease-1', action: 'handoff' },
      { leaseId: 'lease-1', action: 'takeover' },
      { leaseId: 'lease-2', action: 'handoff' },
    ],
    'a genuinely new lease must receive its own one-time default handoff',
  );
});

test('about:blank defaults to the exact Agent as soon as its lease is ready', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:blank-then-ready:browser:1',
    agentSessionId: 'runtime-a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => ({
      action: args.action,
      agentSessionId: args.agentSessionId,
    })),
    [{ action: 'handoff', agentSessionId: 'runtime-a' }],
  );

  harness.emitBrowserState(bridge, 'lease-1', 1, {
    url: 'https://accounts.example.test/login?ready=1',
    lifecycle: 'ready',
    loading: false,
  });
  mounted.render({
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:blank-then-ready:browser:1',
    agentSessionId: 'runtime-a',
    presentationRevision: 2,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  assert.equal(
    callsFor(bridge, 'browser_surface_control').length,
    1,
    'later native events and renders must not consume the same lease twice',
  );
});

test('a temporary overlay resumes the exact Agent on the same lease after restore', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;
  let overlay;

  t.after(async () => {
    await overlay?.release();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:overlay-resume:browser:1',
    agentSessionId: 'runtime-a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  await harness.flushEffects();

  overlay = await harness.acquireNativeSurfaceOcclusion();
  await harness.flushEffects();
  assert.equal(
    container.querySelector('[data-ccem-browser-panel="true"]')
      ?.getAttribute('data-ccem-browser-control'),
    'paused',
  );

  await overlay.release();
  overlay = null;
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => ({
      leaseId: args.leaseId,
      generation: args.generation,
      action: args.action,
      agentSessionId: args.agentSessionId,
    })),
    [
      { leaseId: 'lease-1', generation: 1, action: 'handoff', agentSessionId: 'runtime-a' },
      { leaseId: 'lease-1', generation: 1, action: 'occlude', agentSessionId: undefined },
      { leaseId: 'lease-1', generation: 1, action: 'handoff', agentSessionId: 'runtime-a' },
    ],
    'overlay restore must resume only the exact actor that owned this exact lease before occlusion',
  );
});

test('a queued User takeover silently supersedes when an overlay starts before the queue drains', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const invoke = bridge.invoke.bind(bridge);
  let blockNextSync = false;
  let releaseSync;
  let notifySyncStarted;
  const syncStarted = new Promise((resolve) => {
    notifySyncStarted = resolve;
  });
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  bridge.invoke = async (command, args) => {
    if (command === 'browser_surface_sync' && blockNextSync) {
      blockNextSync = false;
      notifySyncStarted();
      await syncGate;
    }
    return invoke(command, args);
  };
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;
  let overlay;

  t.after(async () => {
    releaseSync?.();
    await overlay?.release();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const props = {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:takeover-overlay-race:browser:1',
    agentSessionId: 'runtime-a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  };
  mounted = harness.mountBrowserPanel(container, props);
  await harness.flushEffects();
  await harness.flushEffects();
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['handoff'],
  );

  blockNextSync = true;
  mounted.render({ ...props, presentationRevision: 2 });
  await syncStarted;

  const takeover = container.querySelector(
    'button[aria-label="zh:loginBrowserControl.takeover"]',
  );
  assert.ok(takeover);
  harness.click(takeover);
  const overlayPromise = harness.acquireNativeSurfaceOcclusion();
  await harness.flushEffects();
  releaseSync();
  overlay = await overlayPromise;
  await harness.flushEffects();

  await overlay.release();
  overlay = null;
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['handoff', 'occlude', 'handoff'],
    'the hidden-surface fence must cancel takeover before IPC and restore the prior Agent owner',
  );
  const panel = container.querySelector('[data-ccem-browser-panel="true"]');
  assert.equal(panel?.getAttribute('data-ccem-browser-control'), 'agent');
  assert.equal(panel?.getAttribute('data-ccem-browser-auto-handoff'), 'true');
  assert.deepEqual(bridge.toasts, []);
});

test('an in-flight authoritative User takeover is not undone by a later overlay restore', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const invoke = bridge.invoke.bind(bridge);
  let holdTakeover = false;
  let releaseTakeover;
  let notifyTakeoverStarted;
  const takeoverStarted = new Promise((resolve) => {
    notifyTakeoverStarted = resolve;
  });
  const takeoverGate = new Promise((resolve) => {
    releaseTakeover = resolve;
  });
  bridge.invoke = async (command, args) => {
    const response = await invoke(command, args);
    if (command === 'browser_surface_control' && args.action === 'takeover' && holdTakeover) {
      holdTakeover = false;
      notifyTakeoverStarted();
      await takeoverGate;
    }
    return response;
  };
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;
  let overlay;

  t.after(async () => {
    releaseTakeover?.();
    await overlay?.release();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:inflight-takeover-overlay:browser:1',
    agentSessionId: 'runtime-a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  await harness.flushEffects();

  holdTakeover = true;
  const takeover = container.querySelector(
    'button[aria-label="zh:loginBrowserControl.takeover"]',
  );
  assert.ok(takeover);
  harness.click(takeover);
  await takeoverStarted;

  const overlayPromise = harness.acquireNativeSurfaceOcclusion();
  await harness.flushEffects();
  releaseTakeover();
  overlay = await overlayPromise;
  await harness.flushEffects();
  await overlay.release();
  overlay = null;
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['handoff', 'takeover', 'occlude'],
    'the authoritative User/auto_handoff=false snapshot must erase stale overlay resume intent',
  );
  const panel = container.querySelector('[data-ccem-browser-panel="true"]');
  assert.equal(panel?.getAttribute('data-ccem-browser-control'), 'user');
  assert.equal(panel?.getAttribute('data-ccem-browser-auto-handoff'), 'false');
});

test('an overlay during page loading waits for Ready before restoring automatic Agent control', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const invoke = bridge.invoke.bind(bridge);
  bridge.invoke = async (command, args) => {
    const response = await invoke(command, args);
    if (command === 'browser_surface_control' && args.action === 'occlude') {
      response.snapshot.lifecycle = 'loading';
      response.snapshot.loading = true;
    }
    return response;
  };
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;
  let overlay;

  t.after(async () => {
    await overlay?.release();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:loading-overlay:browser:1',
    agentSessionId: 'runtime-a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  await harness.flushEffects();

  harness.emitBrowserState(bridge, 'lease-1', 1, {
    lifecycle: 'loading',
    loading: true,
  });
  overlay = await harness.acquireNativeSurfaceOcclusion();
  await harness.flushEffects();
  await overlay.release();
  overlay = null;
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['handoff', 'occlude'],
    'overlay restore must not hand off a browser whose authoritative page is still loading',
  );

  harness.emitBrowserState(bridge, 'lease-1', 1, {
    lifecycle: 'ready',
    loading: false,
    control: 'paused',
    paused: true,
    auto_handoff: true,
  });
  await harness.flushEffects();
  await harness.flushEffects();
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['handoff', 'occlude', 'handoff'],
    'the normal one-shot policy should restore Agent only after the exact lease becomes Ready',
  );
});

test('explicit User takeover stays durable across hide/show and later overlay restore', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;
  let overlay;

  t.after(async () => {
    await overlay?.release();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const props = {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:durable-takeover:browser:1',
    agentSessionId: 'runtime-a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  };
  mounted = harness.mountBrowserPanel(container, props);
  await harness.flushEffects();
  await harness.flushEffects();

  const takeover = container.querySelector(
    'button[aria-label="zh:loginBrowserControl.takeover"]',
  );
  assert.ok(takeover);
  harness.click(takeover);
  await harness.flushEffects();
  await harness.flushEffects();

  mounted.render({
    ...props,
    presentationRevision: 2,
    isActiveSurface: false,
    surfaceOccluded: true,
  });
  await harness.flushEffects();
  mounted.render({ ...props, presentationRevision: 3 });
  await harness.flushEffects();
  await harness.flushEffects();
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['handoff', 'takeover'],
    'hiding and showing the retained lease must not undo User takeover',
  );

  overlay = await harness.acquireNativeSurfaceOcclusion();
  await overlay.release();
  overlay = null;
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['handoff', 'takeover', 'occlude'],
    'an overlay must not undo an explicit User takeover',
  );
  assert.ok(container.querySelector(
    'button[aria-label="zh:loginBrowserControl.handoffAgent"]',
  ));
});

test('authoritative User takeover survives a new component and rotated lease for one retained surface', async (t) => {
  const dom = installDom();
  const bridge = createBridge({
    acquireSnapshots: [
      { auto_handoff: true },
      { control: 'user', auto_handoff: false },
    ],
    acquireSurfaceIds: ['retained-surface-a', 'retained-surface-a'],
  });
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const props = {
    locale: 'zh',
    backend: 'login',
    agentSessionId: 'runtime-a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  };
  mounted = harness.mountBrowserPanel(container, {
    ...props,
    sessionId: 'conversation:retained-a:browser:lease-1',
  });
  await harness.flushEffects();
  await harness.flushEffects();
  const takeover = container.querySelector(
    'button[aria-label="zh:loginBrowserControl.takeover"]',
  );
  assert.ok(takeover);
  harness.click(takeover);
  await harness.flushEffects();
  await harness.flushEffects();

  mounted.unmount();
  mounted = null;
  await harness.flushEffects();
  mounted = harness.mountBrowserPanel(container, {
    ...props,
    sessionId: 'conversation:retained-a:browser:lease-2',
    presentationRevision: 2,
  });
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => ({
      leaseId: args.leaseId,
      action: args.action,
    })),
    [
      { leaseId: 'lease-1', action: 'handoff' },
      { leaseId: 'lease-1', action: 'takeover' },
    ],
    'the retained surface snapshot must suppress a new component default handoff',
  );
  const manualHandoff = container.querySelector(
    'button[aria-label="zh:loginBrowserControl.handoffAgent"]',
  );
  assert.ok(manualHandoff);
  harness.click(manualHandoff);
  await harness.flushEffects();
  await harness.flushEffects();
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => ({
      leaseId: args.leaseId,
      action: args.action,
    })),
    [
      { leaseId: 'lease-1', action: 'handoff' },
      { leaseId: 'lease-1', action: 'takeover' },
      { leaseId: 'lease-2', action: 'handoff' },
    ],
    'manual handoff remains available after durable takeover suppresses only the automatic path',
  );
});

test('a paused lease stays fail-closed until the single address-bar icon takes over', async (t) => {
  const dom = installDom();
  const bridge = createBridge({
    acquireSnapshot: { control: 'paused', paused: true, auto_handoff: false },
  });
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:paused:browser:1',
    agentSessionId: 'runtime-a',
    defaultUrl: 'https://accounts.example.test',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  await harness.flushEffects();

  assert.equal(callsFor(bridge, 'browser_surface_control').length, 0);
  const navigation = container.querySelector('[data-ccem-browser-navigation="true"]');
  assert.ok(navigation);
  const takeover = navigation.querySelector(
    '[data-ccem-browser-control-state="paused"][aria-label="zh:loginBrowserControl.takeover"]',
  );
  assert.ok(takeover);
  assert.equal(navigation.querySelectorAll('[data-ccem-browser-control-toggle="true"]').length, 1);
  assert.equal(container.querySelector(
    'button[aria-label="zh:loginBrowserControl.pauseAgent"]',
  ), null);

  harness.click(takeover);
  await harness.flushEffects();
  await harness.flushEffects();
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['takeover'],
  );
});

test('the same runtime returning converges an auto-handoff paused lease back to Agent', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const props = {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:runtime-return:browser:1',
    agentSessionId: 'runtime-a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  };
  mounted = harness.mountBrowserPanel(container, props);
  await harness.flushEffects();
  await harness.flushEffects();
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => args.action),
    ['handoff'],
  );

  mounted.render({ ...props, agentSessionId: undefined, presentationRevision: 2 });
  harness.emitBrowserState(bridge, 'lease-1', 1, {
    control: 'paused',
    paused: true,
    auto_handoff: true,
  });
  await harness.flushEffects();
  assert.equal(callsFor(bridge, 'browser_surface_control').length, 1);

  mounted.render({ ...props, presentationRevision: 3 });
  await harness.flushEffects();
  await harness.flushEffects();
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => ({
      action: args.action,
      agentSessionId: args.agentSessionId,
    })),
    [
      { action: 'handoff', agentSessionId: 'runtime-a' },
      { action: 'handoff', agentSessionId: 'runtime-a' },
    ],
  );
});

test('React StrictMode hands off only the final live lease once', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:strict:browser:1',
    agentSessionId: 'runtime-a',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  }, { strictMode: true });
  await harness.flushEffects();
  await harness.flushEffects();
  await harness.flushEffects();

  const acquires = callsFor(bridge, 'browser_surface_acquire');
  const handoffs = callsFor(bridge, 'browser_surface_control')
    .filter(({ args }) => args.action === 'handoff');
  assert.ok(acquires.length >= 1);
  assert.equal(handoffs.length, 1);
  assert.equal(
    handoffs[0].args.leaseId,
    `lease-${acquires.length}`,
    'a disposed StrictMode lease must never receive Agent control',
  );
});

test('a queued handoff revalidates the current exact Agent before IPC', async (t) => {
  const dom = installDom();
  let releaseSync;
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const bridge = createBridge({ syncGate });
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    releaseSync?.();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const props = {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:actor-race:browser:1',
    agentSessionId: 'runtime-a',
    defaultUrl: 'https://accounts.example.test',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  };
  mounted = harness.mountBrowserPanel(container, props);
  await harness.flushEffects();
  assert.ok(callsFor(bridge, 'browser_surface_sync').length >= 1);
  assert.equal(callsFor(bridge, 'browser_surface_control').length, 0);

  mounted.render({ ...props, agentSessionId: 'runtime-b', presentationRevision: 2 });
  await harness.flushEffects();
  releaseSync();
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => ({
      action: args.action,
      agentSessionId: args.agentSessionId,
    })),
    [{ action: 'handoff', agentSessionId: 'runtime-b' }],
    'runtime A must be cancelled and the current exact Agent gets its own one-time default handoff',
  );
});

test('a same-actor auto-handoff superseded by loading retries once the lease is Ready', async (t) => {
  const dom = installDom();
  let releaseSync;
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const bridge = createBridge({ syncGate });
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    releaseSync?.();
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:same-actor-loading-race:browser:1',
    agentSessionId: 'runtime-a',
    defaultUrl: 'https://accounts.example.test',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  assert.ok(callsFor(bridge, 'browser_surface_sync').length >= 1);
  assert.equal(callsFor(bridge, 'browser_surface_control').length, 0);

  harness.emitBrowserState(bridge, 'lease-1', 1, {
    lifecycle: 'loading',
    loading: true,
  });
  await harness.flushEffects();
  releaseSync();
  await harness.flushEffects();
  await harness.flushEffects();
  assert.equal(
    callsFor(bridge, 'browser_surface_control').length,
    0,
    'the stale queued handoff must not cross the loading fence',
  );

  harness.emitBrowserState(bridge, 'lease-1', 1, {
    lifecycle: 'ready',
    loading: false,
    control: 'user',
    paused: false,
    auto_handoff: true,
  });
  await harness.flushEffects();
  await harness.flushEffects();

  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => ({
      action: args.action,
      agentSessionId: args.agentSessionId,
    })),
    [{ action: 'handoff', agentSessionId: 'runtime-a' }],
    'the same exact auto-handoff attempt must retry after lifecycle convergence',
  );
  assert.deepEqual(bridge.toasts, []);
});

test('a real auto-handoff backend failure remains one-shot for the same lease and actor', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const invoke = bridge.invoke.bind(bridge);
  bridge.invoke = async (command, args) => {
    if (command === 'browser_surface_control' && args.action === 'handoff') {
      bridge.calls.push({ command, args });
      throw new Error('handoff backend unavailable');
    }
    return invoke(command, args);
  };
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const props = {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:handoff-backend-error:browser:1',
    agentSessionId: 'runtime-a',
    defaultUrl: 'https://accounts.example.test',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  };
  mounted = harness.mountBrowserPanel(container, props);
  await harness.flushEffects();
  await harness.flushEffects();
  mounted.render({ ...props, presentationRevision: 2 });
  harness.emitBrowserState(bridge, 'lease-1', 1, {
    lifecycle: 'ready',
    loading: false,
    control: 'user',
    auto_handoff: true,
  });
  await harness.flushEffects();
  await harness.flushEffects();

  assert.equal(
    callsFor(bridge, 'browser_surface_control').length,
    1,
    'a backend failure must not create a render-driven retry loop',
  );
  assert.deepEqual(bridge.toasts, [
    { kind: 'error', message: 'Error: handoff backend unavailable' },
  ]);
});

test('Login opens in user control when no exact runtime exists and close uses close semantics', async (t) => {
  const dom = installDom();
  const bridge = createBridge();
  const { harness, tempDir } = await importBrowserPanelHarness();
  const container = document.querySelector('#root');
  assert.ok(container);
  let mounted;

  t.after(async () => {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  mounted = harness.mountBrowserPanel(container, {
    locale: 'zh',
    backend: 'login',
    sessionId: 'conversation:without-runtime:browser:1',
    defaultUrl: 'https://accounts.example.test',
    presentationRevision: 1,
    isActiveSurface: true,
    surfaceOccluded: false,
    workingDir: '/workspace',
    profileMode: 'default',
    onClose() {},
  });
  await harness.flushEffects();
  await harness.flushEffects();

  const handoff = container.querySelector(
    'button[aria-label="zh:loginBrowserControl.handoffAgent"]',
  );
  assert.ok(handoff);
  assert.ok(handoff.closest('[data-ccem-browser-navigation="true"]'));
  assert.equal(handoff.disabled, true);
  harness.click(handoff);
  await harness.flushEffects();
  assert.equal(callsFor(bridge, 'browser_surface_control').length, 0);

  assert.ok(container.querySelector(
    'button[aria-label="zh:loginBrowserControl.closeBrowser"]',
  ));
  assert.equal(
    container.querySelector('button[aria-label="zh:workspace.browserClose"]'),
    null,
  );
});
