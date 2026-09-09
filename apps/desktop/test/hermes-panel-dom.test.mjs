import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let harness;
let temp;
let dom;
let root;
let container;
let intervalCallbacks;
let invokeCalls;
let current;
let handler;

const platform = { id: 'custom-transport', label: 'Dynamic Transport', available: true, strictSend: true,
  fields: [{ key: 'DYNAMIC_ACCOUNT', label: 'Account', secret: false, required: true },
    { key: 'DYNAMIC_SECRET', label: 'Secret', secret: true, required: true }] };
const source = { platform: platform.id, profile: 'profile-one', transportProfile: 'transport-one', accountRef: 'bot-account-reference-one',
  userId: 'actual-user', chatId: 'actual-chat', threadId: 'actual-thread', chatType: 'dm' };
const pending = { id: 'pair-one', source, expiresAt: Date.now() + 600000 };
function snapshot(patch = {}) {
  return { installer: { state: 'installed', version: 'fixture-v1', downloadedBytes: 0, totalBytes: null, retryable: false },
    gateway: { state: 'ready', platforms: [platform] }, pending: [], routes: [], operations: [], deliveries: [],
    workspaces: ['/projects/one', '/projects/two'], ...patch };
}
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test.before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-hermes-ui-'));
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'Event', 'MouseEvent', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Match the repo's DOM harness: Node MessageChannel keeps React's scheduler
  // alive after unmount, whereas a browser channel belongs to the page lifetime.
  globalThis.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  };
  const output = path.join(temp, 'harness.cjs');
  await build({
    stdin: { contents: `import React, {act} from 'react'; import {createRoot} from 'react-dom/client';
      import {HermesPanel} from '@/components/chat-app/hermes/HermesPanel';
      import {ChatApp} from '@/pages/ChatApp';
      export {act}; export function mount(container, wholePage=false) { const root=createRoot(container);
        act(()=>root.render(React.createElement(wholePage ? ChatApp : HermesPanel))); return root; }`,
      loader: 'tsx', resolveDir: desktop },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
    plugins: [{ name: 'Hermes DOM boundary', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/locales$/ }, () => ({ path: 'locale', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/hooks\/useTauriCommands$/ }, () => ({ path: 'hooks', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({ path: 'motion', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/components\/chat-app\/(telegram|wecom|weixin)\// }, (args) => ({ path: args.path.split('/').at(-1), namespace: 'hermes-stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'hermes-stub' }, (args) => {
        if (args.path === 'ipc') return { contents: 'export const invoke=(name,args)=>globalThis.__hermesInvoke(name,args);', loader: 'js' };
        if (args.path === 'locale') return { contents: `export function useLocale(){return {lang:'en',t:(key,params={})=>key+Object.values(params).map(value=>' '+value).join('')}}`, loader: 'js' };
        if (args.path === 'hooks') return { contents: `const methods={getPlatformCapabilities:async()=>({tmuxSupported:false,tmuxInstalled:false})}; export function useTauriCommands(){return methods}`, loader: 'js' };
        if (args.path === 'motion') return { contents: `export const ccemMotion={};export const clearMotionProps=()=>{};export const getMotionTargets=()=>[];export const gsap={};export const shouldReduceMotion=()=>true;export const useGSAP=()=>{};`, loader: 'js' };
        return { contents: `import React from 'react'; export function ${args.path}(){return React.createElement('div',{'data-legacy-panel':true},'Existing platform')}`, loader: 'js', resolveDir: desktop };
      });
      builder.onResolve({ filter: /^@\// }, async (args) => {
        const base = path.join(desktop, 'src', args.path.slice(2));
        for (const suffix of ['', '.ts', '.tsx', '/index.tsx']) {
          try { if ((await fs.stat(base + suffix)).isFile()) return { path: base + suffix }; } catch {}
        }
        return { errors: [{ text: `Missing source ${args.path}` }] };
      });
    } }],
  });
  harness = require(output);
});

test.beforeEach(() => {
  current = snapshot();
  invokeCalls = [];
  intervalCallbacks = [];
  handler = async () => structuredClone(current);
  globalThis.__hermesInvoke = async (name, args) => { invokeCalls.push({ name, args }); return handler(name, args); };
  dom.window.setInterval = (callback) => { intervalCallbacks.push(callback); return intervalCallbacks.length; };
  dom.window.clearInterval = (id) => { intervalCallbacks[id - 1] = null; };
  container = document.createElement('div');
  document.body.appendChild(container);
});
test.afterEach(async () => {
  if (root) await harness.act(async () => root.unmount());
  root = null;
  container.remove();
});
test.after(async () => { dom.window.close(); await fs.rm(temp, { recursive: true, force: true }); stopEsbuild(); });

async function settle() { await harness.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function mount(wholePage = false) { root = harness.mount(container, wholePage); await settle(); }
const button = (label) => [...container.querySelectorAll('button')].find((node) => node.textContent === label);
const actions = (name) => invokeCalls.filter((call) => call.name === 'hermes_action' && (!name || call.args.action === name));
async function click(node) { assert.ok(node, 'click target exists'); await harness.act(async () => node.click()); }
async function input(id, value) {
  const node = document.getElementById(id); assert.ok(node, id);
  await harness.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function poll() { await harness.act(async () => { for (const callback of intervalCallbacks) callback?.(); }); await settle(); }

test('Hermes is the default page and existing panels mount only after expanding', async () => {
  await mount(true);
  assert.ok(container.querySelector('[data-hermes-panel]'));
  assert.equal(container.querySelector('[data-legacy-panel]'), null);
  await click(button('hermes.existingConnections'));
  assert.ok(container.querySelector('[data-legacy-panel]'));
  await click(button('hermes.existingConnections'));
  assert.equal(container.querySelector('[data-legacy-panel]'), null);
});

test('install double-click starts once and cancellation waits for backend acceptance', async () => {
  current = snapshot({ installer: { state: 'not_installed', downloadedBytes: 0, retryable: false }, gateway: { state: 'stopped', platforms: [] } });
  const installation = deferred();
  handler = async (name, args) => {
    if (args?.action === 'install') return installation.promise;
    if (args?.action === 'cancelInstall') return snapshot({ installer: { state: 'cancelled', downloadedBytes: 12, retryable: true } });
    return structuredClone(current);
  };
  await mount();
  const install = button('hermes.install');
  await harness.act(async () => { install.click(); install.click(); });
  assert.equal(actions('install').length, 1);
  assert.equal(button('hermes.cancel').disabled, true, 'a pending request is not proof that prepare_install has run');
  assert.ok(container.textContent.includes('hermes.installRequested'));
  await click(button('hermes.cancel'));
  assert.equal(actions('cancelInstall').length, 0);
  current = snapshot({ installer: { state: 'checking', downloadedBytes: 0, retryable: false } });
  await poll();
  assert.equal(button('hermes.cancel').disabled, false);
  await click(button('hermes.cancel'));
  assert.equal(actions('cancelInstall').length, 1);
  await harness.act(async () => installation.resolve(snapshot({ installer: { state: 'installed', version: 'stale-result', downloadedBytes: 0, retryable: false } })));
  assert.ok(button('hermes.retryInstall'), 'cancel result is not overwritten by stale install response');
  assert.equal(container.textContent.includes('stale-result'), false);
});

test('a rejected install request can be retried without ever enabling premature cancellation', async () => {
  current = snapshot({ installer: { state: 'not_installed', downloadedBytes: 0, retryable: false } });
  const installation = deferred();
  handler = async (name, args) => args?.action === 'install' ? installation.promise : structuredClone(current);
  await mount();
  await click(button('hermes.install'));
  assert.equal(button('hermes.cancel').disabled, true);
  await harness.act(async () => installation.reject(new Error('install reservation unavailable')));
  assert.equal(button('hermes.install').disabled, false);
  assert.equal(button('hermes.cancel'), undefined);
  assert.equal(actions('cancelInstall').length, 0);
  assert.ok(container.querySelector('[role="alert"]').textContent.includes('install reservation unavailable'));
});

test('dynamic configuration sends only known fields and clears entered secrets after successful save', async () => {
  handler = async (name, args) => args?.action === 'configureChannel' ? snapshot({ gateway: {
    state: 'running', platforms: [platform], configuredPlatform: platform.id, configuredFields: ['DYNAMIC_ACCOUNT', 'DYNAMIC_SECRET'],
  } }) : structuredClone(current);
  await mount();
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').type, 'password');
  assert.equal(button('hermes.saveChannel').disabled, true);
  await input('hermes-field-DYNAMIC_ACCOUNT', 'account-one');
  await input('hermes-field-DYNAMIC_SECRET', 'secret-value-123');
  await click(button('hermes.saveChannel'));
  assert.deepEqual(actions('configureChannel')[0].args.payload, { platform: 'custom-transport', fields: { DYNAMIC_ACCOUNT: 'account-one', DYNAMIC_SECRET: 'secret-value-123' } });
  assert.equal(container.textContent.includes('secret-value-123'), false);
  current = snapshot({ gateway: { state: 'stopped', platforms: [platform], configuredPlatform: platform.id, configuredFields: ['DYNAMIC_ACCOUNT', 'DYNAMIC_SECRET'] } });
  await poll();
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').value, '');
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').placeholder, 'hermes.alreadyConfigured');
  assert.equal(button('hermes.saveChannel').disabled, true, 'unchanged saved settings do not revoke pairings through a redundant save');
  assert.equal(button('hermes.start').disabled, false, 'existing credentials can restart without entering secrets');
  await input('hermes-field-DYNAMIC_ACCOUNT', 'account-updated');
  assert.equal(button('hermes.saveChannel').disabled, false, 'partial changes keep the saved secret');
});

test('configuration errors redact entered secrets and permit a deliberate retry', async () => {
  handler = async (name, args) => { if (args?.action === 'configureChannel') throw new Error('bad credential secret-ABC'); return structuredClone(current); };
  await mount();
  await input('hermes-field-DYNAMIC_ACCOUNT', 'one');
  await input('hermes-field-DYNAMIC_SECRET', 'secret-ABC');
  await click(button('hermes.saveChannel'));
  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert.textContent.includes('••••••'));
  assert.equal(alert.textContent.includes('secret-ABC'), false);
  assert.equal(button('hermes.saveChannel').disabled, false);
});

test('stopping the channel reloads editable metadata without reconnecting or entering saved secrets', async () => {
  const configured = { configuredPlatform: platform.id, configuredFields: ['DYNAMIC_ACCOUNT', 'DYNAMIC_SECRET'] };
  current = snapshot({ gateway: { state: 'running', platforms: [platform], ...configured } });
  handler = async (name, args) => args?.action === 'stop'
    ? snapshot({ gateway: { state: 'starting', platforms: [], ...configured } }) : structuredClone(current);
  await mount();
  await click(button('hermes.stop'));
  assert.equal(actions('stop').length, 1);
  assert.equal(button('hermes.start').disabled, true);
  current = snapshot({ gateway: { state: 'configured', platforms: [platform], ...configured } });
  await poll();
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').value, '');
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').placeholder, 'hermes.alreadyConfigured');
  await input('hermes-field-DYNAMIC_ACCOUNT', 'replacement-account');
  assert.equal(button('hermes.saveChannel').disabled, false);
  await click(button('hermes.saveChannel'));
  assert.deepEqual(actions('configureChannel')[0].args.payload.fields, { DYNAMIC_ACCOUNT: 'replacement-account' });
  assert.equal(actions('start').length, 0, 'editing does not reconnect the old account first');
});

test('platform metadata with strictSend=false cannot start the new channel path', async () => {
  current = snapshot({ gateway: { state: 'ready', platforms: [{ ...platform, strictSend: false }] } });
  await mount();
  assert.equal(button('hermes.saveChannel').disabled, true);
  assert.equal(button('hermes.start').disabled, true);
  assert.equal(actions().length, 0);
});

test('pairing approval binds the displayed recipient and explicitly selected workspaces with input off by default', async () => {
  current = snapshot({ gateway: { state: 'running', platforms: [platform], configuredPlatform: platform.id }, pending: [pending] });
  const approval = deferred();
  handler = async (name, args) => args?.action === 'approvePairing' ? approval.promise : structuredClone(current);
  await mount();
  assert.ok(container.textContent.includes('actual-user'));
  assert.ok(container.textContent.includes('actual-chat'));
  assert.ok(container.textContent.includes('actual-thread'));
  assert.ok(container.querySelector('[title="bot-account-reference-one"]'), 'the displayed recipient keeps its bot account reference available');
  assert.equal(button('hermes.approvePairing').disabled, true);
  assert.equal(container.querySelector('[aria-label="hermes.allowInput"]').getAttribute('aria-checked'), 'false');
  await click(container.querySelector('[aria-label="/projects/one"]'));
  const approve = button('hermes.approvePairing');
  await harness.act(async () => { approve.click(); approve.click(); });
  assert.equal(actions('approvePairing').length, 1);
  assert.deepEqual(actions('approvePairing')[0].args.payload, { id: 'pair-one', workspaces: ['/projects/one'], allowInput: false, notifications: true });
  await harness.act(async () => approval.resolve(snapshot({ gateway: current.gateway,
    routes: [{ id: 'route-one', generation: 1, source, workspaces: ['/projects/one'], enabled: true, allowInput: false, notifications: true }] })));
  assert.ok(button('hermes.disableRoute'));
});

test('workspace search keeps hidden selections while confirming from a large workspace list', async () => {
  current = snapshot({ gateway: { state: 'running', platforms: [platform], configuredPlatform: platform.id }, pending: [pending],
    workspaces: Array.from({ length: 515 }, (_, index) => `/projects/workspace-${index}`) });
  await mount();
  await click(container.querySelector('[aria-label="/projects/workspace-0"]'));
  await input('hermes-workspace-search-pair-one', 'WORKSPACE-514');
  assert.equal(container.querySelector('[aria-label="/projects/workspace-0"]'), null);
  await click(container.querySelector('[aria-label="/projects/workspace-514"]'));
  assert.ok(container.textContent.includes('hermes.selectedWorkspaces 2'));
  await input('hermes-workspace-search-pair-one', 'no matching project');
  assert.ok(container.textContent.includes('hermes.noMatchingWorkspaces'));
  assert.equal(button('hermes.approvePairing').disabled, false, 'filtering does not clear the selected workspaces');
  await input('hermes-workspace-search-pair-one', '');
  assert.equal(container.querySelector('[aria-label="/projects/workspace-0"]').getAttribute('aria-checked'), 'true');
  assert.equal(container.querySelector('[aria-label="/projects/workspace-514"]').getAttribute('aria-checked'), 'true');
  await click(button('hermes.approvePairing'));
  assert.deepEqual(actions('approvePairing')[0].args.payload.workspaces, ['/projects/workspace-0', '/projects/workspace-514']);
});

test('expired pending pairing cannot be approved', async () => {
  current = snapshot({ gateway: { state: 'running', platforms: [platform], configuredPlatform: platform.id }, pending: [{ ...pending, expiresAt: Date.now() - 10000 }] });
  await mount();
  assert.equal(button('hermes.pairingExpired').disabled, true);
  assert.equal(container.querySelector('[aria-label="/projects/one"]').disabled, true);
  assert.equal(actions('approvePairing').length, 0);
});

test('new pairing displays and copies the exact code without approving any recipient', async () => {
  current = snapshot({ gateway: { state: 'running', platforms: [platform], configuredPlatform: platform.id } });
  handler = async (name, args) => args?.action === 'openPairing'
    ? { ...structuredClone(current), pairing: { code: 'ABCD1234', expiresAt: Date.now() + 600000 } }
    : structuredClone(current);
  let copied;
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { copied = value; } } });
  await mount();
  await click(button('hermes.newPairing'));
  assert.equal(container.querySelector('code').textContent, '/ccem connect ABCD1234');
  await click(container.querySelector('[aria-label="hermes.copyCommand"]'));
  assert.equal(copied, '/ccem connect ABCD1234');
  assert.equal(actions('approvePairing').length, 0);
});

test('disabling a route submits its exact ID and waits for the returned disabled state', async () => {
  const route = { id: 'route-to-disable', generation: 1, source, workspaces: ['/projects/one'], enabled: true, allowInput: true, notifications: true };
  current = snapshot({ routes: [route] });
  const result = deferred();
  handler = async (name, args) => args?.action === 'disableRoute' ? result.promise : structuredClone(current);
  await mount();
  await click(button('hermes.disableRoute'));
  assert.deepEqual(actions('disableRoute')[0].args.payload, { id: 'route-to-disable' });
  assert.equal(button('hermes.disableRoute').disabled, true);
  assert.equal(button('hermes.routeDisabled'), undefined);
  await harness.act(async () => result.resolve(snapshot({ routes: [{ ...route, enabled: false }] })));
  assert.equal(button('hermes.routeDisabled').disabled, true);
});

test('a failed status read recovers on refresh without leaving a stale error visible', async () => {
  handler = async () => { throw new Error('status transport unavailable'); };
  await mount();
  assert.ok(container.querySelector('[role="alert"]').textContent.includes('status transport unavailable'));
  handler = async () => structuredClone(current);
  await click(container.querySelector('[aria-label="hermes.refresh"]'));
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.ok(button('hermes.saveChannel'));
});

test('installed component with no configured channel can restart metadata loading after failure', async () => {
  current = snapshot({ gateway: { state: 'stopped', platforms: [], error: 'metadata startup failed' } });
  handler = async (name, args) => args?.action === 'start' ? snapshot({ gateway: { state: 'starting', platforms: [] } }) : structuredClone(current);
  await mount();
  assert.equal(button('hermes.loadPlatforms').disabled, false);
  await click(button('hermes.loadPlatforms'));
  assert.deepEqual(actions('start')[0].args, { action: 'start' });
  assert.equal(button('hermes.loadPlatforms').disabled, true);
  current = snapshot({ gateway: { state: 'unconfigured', platforms: [platform] } });
  await poll();
  assert.ok(document.getElementById('hermes-field-DYNAMIC_SECRET'));
});

test('newest activity stays visible for descending backend lists and running tasks use execution status', async () => {
  const now = Date.now();
  current = snapshot({ operations: Array.from({ length: 20 }, (_, i) => ({ id: `op-${i}`, runtimeId: `runtime-${i}`, state: 'running', detail: `detail-${i}`, updatedAt: now - i * 1000 })),
    deliveries: Array.from({ length: 20 }, (_, i) => ({ id: `delivery-${i}`, status: 'sent', createdAt: now - i * 1000 })) });
  await mount();
  assert.ok(container.textContent.includes('runtime-0'));
  assert.equal(container.textContent.includes('runtime-19'), false);
  assert.ok(container.textContent.includes('delivery-0'));
  assert.equal(container.textContent.includes('delivery-19'), false);
  assert.ok([...container.querySelectorAll('span')].some((node) => node.textContent === 'started'));
});

test('a stale poll cannot overwrite a newer action response', async () => {
  await mount();
  const stale = deferred();
  handler = async (name) => name === 'hermes_status' ? stale.promise : snapshot({ gateway: { state: 'running', platforms: [platform], configuredPlatform: platform.id } });
  await poll();
  // Existing configuration is set via a regular status update before starting a
  // later action; here removeRuntime is available without a configured channel.
  await click(button('hermes.removeComponent'));
  await harness.act(async () => stale.resolve(snapshot({ installer: { state: 'not_installed', downloadedBytes: 0, retryable: false } })));
  assert.ok(button('hermes.stop'), 'new action status survives the older read');
  assert.equal(button('hermes.install'), undefined);
});

test('status polling renders completed operations separately from unknown message delivery', async () => {
  await mount();
  current = snapshot({ operations: [{ id: 'operation', runtimeId: 'native-one', state: 'completed', detail: 'task finished', updatedAt: Date.now() }],
    deliveries: [{ id: 'delivery', status: 'unknown', createdAt: Date.now() }] });
  await poll();
  assert.ok([...container.querySelectorAll('span')].some((node) => node.textContent === 'completed'));
  assert.ok([...container.querySelectorAll('span')].some((node) => node.textContent === 'unknown'));
  assert.ok(container.textContent.includes('hermes.operations'));
  assert.ok(container.textContent.includes('hermes.deliveries'));
});
