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
            export function TooltipContent() { return null; }
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

        export function emitBrowserState(bridge, leaseId, generation, snapshot) {
          act(() => bridge.emitBrowserState(leaseId, generation, snapshot));
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
    handle.unref?.();
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

function createBridge({ acquireSnapshot = {}, syncGate = null } = {}) {
  let loginGeneration = 0;
  let loginServerSequence = 100;
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
          return {
            lease_id: `lease-${loginGeneration}`,
            generation: loginGeneration,
            surface_id: `surface-${loginGeneration}`,
            client_revision: args.clientRevision,
            server_sequence: loginGeneration,
            backend: 'login',
            profile_id: 'shared-profile',
            snapshot: {
              url: args.initialUrl ?? null,
              title: 'Login',
              visible: false,
              loading: false,
              error: null,
              lifecycle: 'ready',
              control: 'user',
              paused: false,
              profile_id: 'shared-profile',
              session_status: 'running',
              recovery_states: [],
              popup_active: false,
              popup_url: null,
              popup_title: null,
              popup_loading: false,
              popup_error: null,
              ...acquireSnapshot,
            },
          };
        }
        case 'browser_surface_sync':
          if (syncGate) await syncGate;
          return undefined;
        case 'browser_surface_release':
        case 'browser_surface_navigate':
          return undefined;
        case 'browser_surface_control':
          return {
            lease_id: args.leaseId,
            generation: args.generation,
            server_sequence: ++loginServerSequence,
            snapshot: {
              lifecycle: 'ready',
              control: args.action === 'handoff' ? 'agent' : 'user',
              paused: false,
              session_status: 'running',
              recovery_states: [],
              popup_active: false,
            },
          };
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

  mounted.unmount();
  mounted = null;
  await harness.flushEffects();
  const releases = callsFor(bridge, 'browser_surface_release');
  assert.equal(releases.length, 1, 'real unmount must close the exact Login lease');
  assert.equal(releases[0].args.disposition, 'close');
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
  assert.ok(navigation.querySelector(
    'button[aria-label="zh:loginBrowserControl.handoffAgent"]',
  ));

  mounted.render({
    ...props,
    sessionId: 'conversation:agent-default:browser:2',
    presentationRevision: 3,
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

test('about:blank waits for the first authoritative HTTP page before the lease defaults to Agent', async (t) => {
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

  assert.equal(callsFor(bridge, 'browser_surface_control').length, 0);
  harness.emitBrowserState(bridge, 'lease-1', 1, {
    url: 'https://accounts.example.test/login',
    lifecycle: 'ready',
    loading: false,
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

test('a paused lease stays fail-closed until the single address-bar icon takes over', async (t) => {
  const dom = installDom();
  const bridge = createBridge({
    acquireSnapshot: { control: 'paused', paused: true },
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
    defaultUrl: 'https://accounts.example.test',
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

  assert.equal(
    callsFor(bridge, 'browser_surface_control').length,
    0,
    'the queued handoff for runtime A must be cancelled after the exact actor changes',
  );
  const retry = container.querySelector(
    '[data-ccem-browser-control-toggle="true"][aria-label="zh:loginBrowserControl.handoffAgent"]',
  );
  assert.ok(retry);
  harness.click(retry);
  await harness.flushEffects();
  await harness.flushEffects();
  assert.deepEqual(
    callsFor(bridge, 'browser_surface_control').map(({ args }) => ({
      action: args.action,
      agentSessionId: args.agentSessionId,
    })),
    [{ action: 'handoff', agentSessionId: 'runtime-b' }],
    'the user can explicitly hand the same lease to the newly selected exact Agent',
  );
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
