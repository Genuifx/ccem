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
let mountPoint;
let intervalCallbacks;
let invokeCalls;
let current;
let handler;

const platform = { id: 'custom-transport', label: 'Dynamic Transport', available: true, strictSend: true,
  fields: [{ key: 'DYNAMIC_ACCOUNT', label: 'Account', secret: false, required: true },
    { key: 'DYNAMIC_SECRET', label: 'Secret', secret: true, required: true }] };
const qrPlatform = { ...platform, id: 'wecom', label: 'WeCom', qrSetup: true };
const qrSetup = { id: 'qr-one', platform: 'wecom', state: 'waiting', qrPayload: 'https://work.weixin.qq.com/ccem-fixture-one', expiresAt: Date.now() + 300000 };
function qrSnapshot(patch = {}) {
  return snapshot({ gateway: { state: 'unconfigured', platforms: [qrPlatform] }, ...patch });
}
const source = { platform: platform.id, profile: 'profile-one', transportProfile: 'transport-one', accountRef: 'bot-account-reference-one',
  userId: 'actual-user', chatId: 'actual-chat', threadId: 'actual-thread', chatType: 'dm' };
const pending = { id: 'pair-one', source, expiresAt: Date.now() + 600000 };
function connection(patch = {}) {
  return { accountRef: source.accountRef, platform: platform.id, label: 'Transport one', configuredFields: [], enabled: true, state: 'running', pending: [], ...patch };
}
function snapshot(patch = {}) {
  return { installer: { state: 'installed', version: 'fixture-v1', downloadedBytes: 0, totalBytes: null, retryable: false },
    gateway: { state: 'ready', platforms: [platform] }, connections: [], routes: [], operations: [], deliveries: [],
    workspaces: ['/projects/one', '/projects/two'], ...patch };
}
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test.before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-hermes-ui-'));
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'NodeFilter', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'Event', 'MouseEvent', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  // Radix Switch observes its hidden form input; JSDOM has no layout observer.
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
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
    loader: { '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [{ name: 'Hermes DOM boundary', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/locales$/ }, () => ({ path: 'locale', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/hooks\/useTauriCommands$/ }, () => ({ path: 'hooks', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({ path: 'motion', namespace: 'hermes-stub' }));
      builder.onResolve({ filter: /^@\/components\/chat-app\/(telegram|wecom|weixin)\// }, (args) => ({ path: args.path.split('/').at(-1), namespace: 'hermes-stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'hermes-stub' }, (args) => {
        if (args.path === 'ipc') return { contents: 'export const invoke=(name,args)=>globalThis.__hermesInvoke(name,args); export class Channel { constructor(){throw new Error("Unexpected streaming IPC in Hermes DOM test")} }', loader: 'js' };
        if (args.path === 'locale') return { contents: `export function useLocale(){return {lang:'en',t:(key,params={})=>globalThis.__hermesTranslate?.(key,params)??({'hermes.platformWecom':'WeCom','hermes.platformFeishu':'Feishu'}[key]??key)+Object.values(params).map(value=>' '+value).join('')}}`, loader: 'js' };
        if (args.path === 'hooks') return { contents: `const methods={getPlatformCapabilities:async()=>({tmuxSupported:false,tmuxInstalled:false})}; export function useTauriCommands(){return methods}`, loader: 'js' };
        if (args.path === 'motion') return { contents: `export const ccemMotion={};export const clearMotionProps=()=>{};export const getMotionTargets=()=>[];export const gsap={};export const shouldReduceMotion=()=>true;export const useGSAP=()=>{};`, loader: 'js' };
        return { contents: `import React from 'react'; export function ${args.path}(){return React.createElement('div',{'data-legacy-panel':true,'data-legacy-platform':'${args.path}'},'Existing platform')}`, loader: 'js', resolveDir: desktop };
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
  globalThis.__hermesTranslate = undefined;
  globalThis.__hermesInvoke = async (name, args) => { invokeCalls.push({ name, args }); return handler(name, args); };
  dom.window.setInterval = (callback) => { intervalCallbacks.push(callback); return intervalCallbacks.length; };
  dom.window.clearInterval = (id) => { intervalCallbacks[id - 1] = null; };
  container = document.body;
  mountPoint = document.createElement('main');
  document.body.appendChild(mountPoint);
});
test.afterEach(async () => {
  if (root) await harness.act(async () => root.unmount());
  root = null;
  container.innerHTML = '';
});
test.after(async () => { dom.window.close(); await fs.rm(temp, { recursive: true, force: true }); stopEsbuild(); });

async function settle() { await harness.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function mount(wholePage = false) { root = harness.mount(mountPoint, wholePage); await settle(); }
const button = (label, scope = container) => [...scope.querySelectorAll('button')].find((node) => node.textContent === label);
const card = (accountRef = source.accountRef) => container.querySelector(`[data-hermes-connection="${accountRef}"]`);
async function addBot() {
  await closeDetails();
  if (!container.querySelector('[data-hermes-editor]')) await click(button('hermes.addChannel'));
}
async function closeDetails() {
  const close = container.querySelector('[aria-label="hermes.closeDetails"]');
  if (close) await click(close);
}
async function openDetails(accountRef = source.accountRef) {
  let drawer = container.querySelector(`[data-hermes-drawer="${accountRef}"]`);
  if (drawer) return drawer;
  await closeDetails();
  const trigger = container.querySelector(`[data-hermes-open="${accountRef}"]`);
  await click(trigger);
  await settle();
  drawer = container.querySelector(`[data-hermes-drawer="${accountRef}"]`);
  assert.ok(drawer, 'managing a bot opens its drawer');
  return drawer;
}
async function selectPlatform(id) { await addBot(); await click(container.querySelector(`[data-hermes-platform="${id}"] button`)); }
async function mountQr() { await mount(); if (!container.querySelector('[data-hermes-editor]')) await addBot(); if (container.querySelector('[data-hermes-channel-picker]')) await selectPlatform(qrPlatform.id); }
async function mountManual() { await mount(); await selectPlatform(platform.id); }
const actions = (name) => invokeCalls.filter((call) => call.name === 'hermes_action' && (!name || call.args.action === name));
async function click(node) {
  assert.ok(node, 'click target exists');
  // Follow the same disclosure path as a user before reaching a nested action.
  const hiddenParents = [];
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.hidden && parent.hasAttribute('data-hermes-disclosure-content')) hiddenParents.unshift(parent);
  }
  for (const parent of hiddenParents) {
    const trigger = [...container.querySelectorAll('button[aria-controls]')].find((item) => item.getAttribute('aria-controls') === parent.id);
    assert.ok(trigger, 'hidden actions have an accessible disclosure');
    await harness.act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(parent.hidden, false, 'disclosure reveals the action before clicking');
  }
  await harness.act(async () => { node.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}
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

for (const state of ['loading', 'failed', 'not_installed']) {
  test(`existing remote control stays usable while Hermes is ${state}`, async () => {
    const statusRead = deferred();
    handler = async () => {
      if (state === 'loading') return statusRead.promise;
      if (state === 'failed') throw new Error('status transport unavailable');
      return snapshot({ installer: { state: 'not_installed', downloadedBytes: 0, retryable: false }, gateway: { state: 'stopped', platforms: [] } });
    };
    await mount(true);
    await click(button('hermes.existingConnections'));
    for (const [id, panel] of [['wecom', 'WecomPanel'], ['telegram', 'TelegramPanel'], ['weixin', 'WeixinPanel']]) {
      const tab = container.querySelector(`[data-chat-platform-tab="${id}"]`);
      await click(tab);
      assert.equal(tab.getAttribute('aria-pressed'), 'true');
      assert.equal(container.querySelector('[data-legacy-panel]')?.dataset.legacyPlatform, panel);
    }
    assert.equal(actions().length, 0, 'using existing connections does not install or configure Hermes');
    if (state === 'loading') {
      await harness.act(async () => { statusRead.resolve(snapshot()); });
      await settle();
      assert.equal(container.querySelector('[data-legacy-panel]')?.dataset.legacyPlatform, 'WeixinPanel', 'Hermes recovery preserves the active old connection');
    }
  });
}

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

test('an installed component updates explicitly and reuses install progress for active connections', async () => {
  current = snapshot({ connections: [connection()] });
  const installation = deferred();
  handler = async (name, args) => args?.action === 'install' ? installation.promise : structuredClone(current);
  await mount();
  assert.equal(actions('install').length, 0, 'opening an installed component never updates automatically');
  await click(container.querySelector('[aria-controls="hermes-runtime-details"]'));
  const update = button('hermes.updateComponent');
  assert.equal(update.disabled, false, 'the backend stops and restores active connections during an explicit update');
  assert.equal(button('hermes.removeComponent').disabled, true);
  await harness.act(async () => { update.click(); update.click(); });
  assert.equal(actions('install').length, 1);
  assert.equal(button('hermes.updateComponent'), undefined);
  assert.ok(container.textContent.includes('hermes.installRequested'));
  assert.equal(button('hermes.cancel').disabled, true);
  current = snapshot({ installer: { state: 'downloading', downloadedBytes: 12, totalBytes: 24, retryable: false } });
  await poll();
  assert.equal(container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '50');
  assert.equal(button('hermes.cancel').disabled, false);
  current = snapshot({ installer: { state: 'installed', version: 'fixture-v2', downloadedBytes: 24, retryable: false }, connections: [connection()] });
  await harness.act(async () => installation.resolve(structuredClone(current)));
  assert.ok(container.textContent.includes('fixture-v2'));
  assert.equal(button('hermes.updateComponent').disabled, false);
  assert.ok(button('hermes.stop', await openDetails()));
});

test('post-download installation phases show indeterminate progress instead of a completed download', async () => {
  current = snapshot({ installer: { state: 'verifying', downloadedBytes: 162 * 1024 * 1024, totalBytes: 162 * 1024 * 1024, retryable: false } });
  await mount();
  for (const state of ['verifying', 'extracting', 'activating', 'checking']) {
    current.installer.state = state;
    await poll();
    const progress = container.querySelector('[role="progressbar"]');
    assert.equal(progress.getAttribute('aria-valuenow'), null, state);
    assert.equal(progress.getAttribute('data-state'), 'indeterminate', state);
    assert.equal(container.textContent.includes('162.0 MB'), false);
    assert.equal(container.querySelector('[role="status"]').textContent, state);
  }
});

test('cancelled and failed updates keep the activated runtime connections available', async () => {
  const launch = { runtimeRoot: '/fixture/old-runtime', python: '/fixture/python', source: '/fixture/source', host: '/fixture/host.py' };
  current = snapshot({ installer: { state: 'cancelled', version: 'fixture-v1', downloadedBytes: 0, retryable: true, launch }, connections: [connection()] });
  await mount();
  assert.equal(button('hermes.stop', await openDetails()).disabled, false);
  assert.ok(button('hermes.retryInstall'));
  current = snapshot({ installer: { ...current.installer, state: 'error', error: 'download failed' }, connections: [connection()] });
  await poll();
  assert.equal(button('hermes.stop', await openDetails()).disabled, false);
  assert.ok(container.textContent.includes('download failed'));
  await click(button('hermes.stop', await openDetails()));
  assert.deepEqual(actions('stop')[0].args.payload, { accountRef: source.accountRef });
  current = snapshot({ installer: { ...current.installer, launch: null }, connections: [connection()] });
  await poll();
  assert.equal(card(), null, 'a version label alone does not prove an activated runtime exists');
});

test('an update with a retained runtime disables discovery, channel creation and scan controls', async () => {
  const installer = { state: 'downloading', downloadedBytes: 12, totalBytes: 24, retryable: false,
    launch: { runtimeRoot: '/fixture/old-runtime', python: '/fixture/python', source: '/fixture/source', host: '/fixture/host.py' } };
  current = snapshot({ installer, gateway: { state: 'stopped', platforms: [] } });
  await mount();
  assert.equal(button('hermes.addChannel').disabled, true);
  await click(button('hermes.addChannel'));
  assert.equal(actions('refreshPlatforms').length, 0);
  current = qrSnapshot({ installer });
  await poll();
  assert.equal(button('hermes.addChannel').disabled, true);
  current = qrSnapshot();
  await poll();
  await selectPlatform('wecom');
  current = qrSnapshot({ installer });
  await poll();
  assert.equal(button('hermes.scanGenerate').disabled, true);
  assert.equal(button('hermes.manualConnect').disabled, true);
  await click(button('hermes.scanGenerate'));
  assert.equal(actions('beginSetup').length, 0);
});

test('pending manual creation keeps the independent wizard locked and continues with its new account', async () => {
  current = snapshot({ connections: [connection()] });
  const result = deferred();
  handler = async (name, args) => args?.action === 'configureChannel' ? result.promise : structuredClone(current);
  await mountManual();
  await input('hermes-field-DYNAMIC_ACCOUNT', 'new-account');
  await input('hermes-field-DYNAMIC_SECRET', 'test-secret');
  await click(button('hermes.saveChannel'));
  assert.equal(button('hermes.saveChannel').disabled, true);
  assert.equal(button('hermes.backToConnections').disabled, true);
  assert.equal(card(), null, 'peer controls are not embedded in the independent wizard');
  current.connections = [connection({ state: 'stopped' }), connection({ accountRef: 'added-account', state: 'error' })];
  await harness.act(async () => result.resolve({ ...structuredClone(current), configuredAccountRef: 'added-account' }));
  assert.ok(container.querySelector('[data-hermes-connection-details="added-account"]'));
  assert.equal(actions('approvePairing').length, 0);
  await click(button('hermes.authorizeLater'));
  assert.ok(card('added-account'));
  assert.ok(card().textContent.includes('stopped'));
});

for (const action of ['beginSetup', 'refreshPlatforms']) {
  test(`pending ${action} keeps the wizard stable while status reads continue`, async () => {
    current = qrSnapshot({ connections: [connection()], ...(action === 'refreshPlatforms' ? { gateway: { state: 'stopped', platforms: [] } } : {}) });
    const result = deferred();
    handler = async (name, args) => args?.action === action ? result.promise : structuredClone(current);
    await mount();
    await addBot();
    if (action === 'beginSetup') await selectPlatform('wecom');
    await click(button(action === 'beginSetup' ? 'hermes.scanGenerate' : 'hermes.loadPlatforms'));
    assert.equal(button('hermes.backToConnections').disabled, true);
    assert.equal(card(), null);
    current.connections = [connection({ state: 'stopped' })];
    await poll();
    await harness.act(async () => result.resolve(structuredClone(current)));
    await click(button('hermes.backToConnections'));
    assert.ok(card().textContent.includes('stopped'));
  });
}

test('slow pairing leaves independent controls and status polling active without rolling back newer actions', async () => {
  const one = connection();
  const two = connection({ accountRef: 'account-two', label: 'Second' });
  current = snapshot({ connections: [one, two] });
  const pairingReply = deferred();
  const stalePairingSnapshot = structuredClone(current);
  handler = async (name, args) => {
    if (args?.action === 'openPairing') return pairingReply.promise;
    if (args?.action === 'stop') current = snapshot({ connections: [one, { ...two, enabled: false, state: 'stopped' }] });
    return structuredClone(current);
  };
  await mount();
  await click(button('hermes.newPairing', await openDetails()));
  assert.equal(button('hermes.newPairing', await openDetails()).disabled, true);
  assert.equal(button('hermes.stop', await openDetails('account-two')).disabled, false);
  await click(button('hermes.stop', await openDetails('account-two')));
  await settle();
  const reads = invokeCalls.filter((call) => call.name === 'hermes_status').length;
  current.connections[0].pairing = { code: 'fresh-poll-code', expiresAt: Date.now() + 600000 };
  await poll();
  assert.ok(invokeCalls.filter((call) => call.name === 'hermes_status').length > reads);
  assert.ok((await openDetails()).textContent.includes('fresh-poll-code'));
  await harness.act(async () => pairingReply.resolve(stalePairingSnapshot));
  await settle();
  assert.ok(button('hermes.start', await openDetails('account-two')), 'the late A response cannot undo B stop');
  assert.ok((await openDetails()).textContent.includes('fresh-poll-code'));
});

test('stop interrupts the same accounts pending pairing and its late rejection stays obsolete', async () => {
  current = snapshot({ connections: [connection()] });
  const pairingReply = deferred();
  handler = async (name, args) => {
    if (args?.action === 'openPairing') return pairingReply.promise;
    if (args?.action === 'stop') current = snapshot({ connections: [connection({ enabled: false, state: 'stopped' })] });
    return structuredClone(current);
  };
  await mount();
  await click(button('hermes.newPairing', await openDetails()));
  assert.equal(button('hermes.stop', await openDetails()).disabled, false);
  await click(button('hermes.stop', await openDetails()));
  assert.deepEqual(actions('stop')[0].args.payload, { accountRef: source.accountRef });
  await harness.act(async () => pairingReply.reject(new Error('obsolete pairing authority changed')));
  await settle();
  assert.ok(button('hermes.start', await openDetails()));
  assert.equal(container.textContent.includes('obsolete pairing authority changed'), false);
});

test('concurrent account replies never restore an older full snapshot after a fresh read', async () => {
  const one = connection();
  const two = connection({ accountRef: 'account-two', label: 'Second' });
  current = snapshot({ connections: [one, two] });
  const firstReply = deferred();
  const secondReply = deferred();
  handler = async (name, args) => args?.action === 'stop'
    ? (args.payload.accountRef === one.accountRef ? firstReply.promise : secondReply.promise) : structuredClone(current);
  await mount();
  await click(button('hermes.stop', await openDetails()));
  await click(button('hermes.stop', await openDetails(two.accountRef)));
  const earlierSecondSnapshot = snapshot({ connections: [one, { ...two, enabled: false, state: 'stopped' }] });
  current = snapshot({ connections: [{ ...one, enabled: false, state: 'stopped' }, { ...two, enabled: false, state: 'stopped' }] });
  await harness.act(async () => firstReply.resolve(structuredClone(current)));
  await settle();
  assert.ok(button('hermes.start', await openDetails()));
  await harness.act(async () => secondReply.resolve(earlierSecondSnapshot));
  await settle();
  assert.ok(button('hermes.start', await openDetails()), 'B was requested later but its delayed response was captured before A stopped');
  assert.ok(button('hermes.start', await openDetails(two.accountRef)));
});

test('a poll started during a mutation cannot replace the completed action snapshot', async () => {
  current = snapshot({ connections: [connection()] });
  const stopReply = deferred();
  const oldRead = deferred();
  handler = async (name, args) => args?.action === 'stop' ? stopReply.promise : structuredClone(current);
  await mount();
  await click(button('hermes.stop', await openDetails()));
  handler = async (name) => name === 'hermes_status' ? oldRead.promise : structuredClone(current);
  await poll();
  await harness.act(async () => stopReply.resolve(snapshot({ connections: [connection({ enabled: false, state: 'stopped' })] })));
  assert.ok(button('hermes.start', await openDetails()));
  await harness.act(async () => oldRead.resolve(structuredClone(current)));
  assert.ok(button('hermes.start', await openDetails()), 'the read began before stop committed');
});

test('a late save on another account does not close the current editor or clear its draft', async () => {
  const one = connection({ configuredFields: ['DYNAMIC_ACCOUNT', 'DYNAMIC_SECRET'] });
  const two = connection({ accountRef: 'account-two', label: 'Second', configuredFields: ['DYNAMIC_ACCOUNT', 'DYNAMIC_SECRET'] });
  current = snapshot({ connections: [one, two] });
  const saveReply = deferred();
  handler = async (name, args) => args?.action === 'configureChannel' ? saveReply.promise : structuredClone(current);
  await mount();
  await click(button('hermes.editConnection', await openDetails()));
  await input('hermes-connection-label', 'Renamed first');
  await click(button('hermes.saveChannel'));
  await click(button('hermes.editConnection', await openDetails('account-two')));
  await input('hermes-connection-label', 'Unsaved second');
  current.connections[0].label = 'Renamed first';
  await harness.act(async () => saveReply.resolve(structuredClone(current)));
  assert.equal(container.querySelector('[data-hermes-manual]').dataset.accountRef, 'account-two');
  assert.equal(document.getElementById('hermes-connection-label').value, 'Unsaved second');
});

test('a successful connection retry clears its obsolete QR connection failure', async () => {
  current = qrSnapshot({ connections: [connection({ platform: 'wecom', state: 'error', error: 'connection failed' })], setup: { ...qrSetup, state: 'error', accountRef: source.accountRef, error: 'setup_connection_failed', qrPayload: undefined } });
  handler = async (name, args) => args?.action === 'start' ? { ...structuredClone(current), connections: [connection({ platform: 'wecom' })] } : structuredClone(current);
  await mount();
  await openDetails();
  assert.ok(container.querySelector('[data-hermes-setup-error]'));
  await click(button('hermes.start', await openDetails()));
  assert.ok(button('hermes.newPairing', await openDetails()));
  assert.equal(container.querySelector('[data-hermes-setup-error]'), null);
});

test('QR-capable platforms default to scan setup without exposing credential fields', async () => {
  current = qrSnapshot();
  const generation = deferred();
  handler = async (name, args) => args?.action === 'beginSetup' ? generation.promise : structuredClone(current);
  await mount();
  await addBot();
  assert.ok(container.querySelector('[data-hermes-channel-picker]'));
  assert.equal(container.querySelector('[data-hermes-setup]'), null);
  await selectPlatform('wecom');
  assert.equal(container.querySelector('[data-hermes-setup]').dataset.setupState, 'idle');
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET'), null);
  assert.equal(container.textContent.includes('DYNAMIC_SECRET'), false);
  assert.equal(actions().length, 0, 'opening the page does not create a bot');
  const generate = button('hermes.scanGenerate');
  await harness.act(async () => { generate.click(); generate.click(); });
  assert.equal(actions('beginSetup').length, 1);
  assert.deepEqual(actions('beginSetup')[0].args.payload, { platform: 'wecom' });
  await harness.act(async () => generation.resolve(qrSnapshot({ setup: { ...qrSetup, state: 'generating', qrPayload: undefined } })));
  assert.ok(container.textContent.includes('hermes.scanGenerating'));
  assert.equal(container.querySelector('svg[data-hermes-qr]'), null);
  current = qrSnapshot({ setup: qrSetup });
  await poll();
  const qr = container.querySelector('svg[data-hermes-qr]');
  assert.ok(qr?.querySelector('path'), 'the received QR payload produces a real SVG QR code');
  assert.ok(container.textContent.includes('hermes.scanWaiting'));
});

test('switching to manual connection cancels the pending QR setup before revealing the form', async () => {
  current = qrSnapshot({ setup: qrSetup });
  const cancellation = deferred();
  handler = async (name, args) => args?.action === 'cancelSetup' ? cancellation.promise : structuredClone(current);
  await mountQr();
  await click(button('hermes.manualConnect'));
  assert.deepEqual(actions('cancelSetup')[0].args.payload, { id: 'qr-one' });
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.equal(button('hermes.manualConnect').disabled, true);
  await harness.act(async () => cancellation.resolve(qrSnapshot({ setup: { ...qrSetup, state: 'cancelled', qrPayload: undefined } })));
  assert.ok(container.querySelector('[data-hermes-manual]'));
  assert.equal(container.querySelector('svg[data-hermes-qr]'), null);
  await input('hermes-field-DYNAMIC_ACCOUNT', 'manual-account');
  await input('hermes-field-DYNAMIC_SECRET', 'manual-secret');
  assert.equal(button('hermes.saveChannel').disabled, false);
  current = qrSnapshot({ setup: { ...qrSetup, state: 'cancelled' } });
  await poll();
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').value, 'manual-secret', 'status polling preserves the manual draft');
  handler = async (name, args) => args?.action === 'configureChannel'
    ? qrSnapshot({ configuredAccountRef: source.accountRef, connections: [connection({ platform: 'wecom' })] }) : structuredClone(current);
  await click(button('hermes.saveChannel'));
  assert.deepEqual(actions('configureChannel')[0].args.payload, { platform: 'wecom', fields: { DYNAMIC_ACCOUNT: 'manual-account', DYNAMIC_SECRET: 'manual-secret' } });
  assert.ok(button('hermes.newPairing'));
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
});

test('a rejected scan cancellation keeps the QR flow visible and can be retried', async () => {
  current = qrSnapshot({ setup: qrSetup });
  handler = async (name, args) => {
    if (args?.action === 'cancelSetup') throw new Error('setup cancellation unavailable');
    return structuredClone(current);
  };
  await mountQr();
  await click(button('hermes.manualConnect'));
  assert.equal(container.querySelector('[role="alert"]').textContent, 'hermes.scanError');
  assert.equal(container.textContent.includes('setup cancellation unavailable'), false);
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.ok(container.querySelector('svg[data-hermes-qr]'));
  assert.equal(button('hermes.manualConnect').disabled, false);
  handler = async (name, args) => args?.action === 'cancelSetup'
    ? qrSnapshot({ setup: { ...qrSetup, state: 'cancelled', qrPayload: undefined } }) : structuredClone(current);
  await click(button('hermes.manualConnect'));
  assert.ok(container.querySelector('[data-hermes-manual]'));
});

test('cancelled scan setup can be restarted and a manual draft can return to the scan entry', async () => {
  current = qrSnapshot({ setup: qrSetup });
  handler = async (name, args) => {
    if (args?.action === 'cancelSetup') return qrSnapshot({ setup: { ...qrSetup, state: 'cancelled', qrPayload: undefined } });
    if (args?.action === 'beginSetup') return qrSnapshot({ setup: { ...qrSetup, id: 'qr-two', state: 'generating', qrPayload: undefined } });
    return structuredClone(current);
  };
  await mountQr();
  await click(button('hermes.cancel'));
  assert.ok(container.textContent.includes('hermes.scanCancelled'));
  assert.equal(container.querySelector('svg[data-hermes-qr]'), null);
  await click(button('hermes.manualConnect'));
  await input('hermes-field-DYNAMIC_SECRET', 'draft-secret');
  await click(button('hermes.useScan'));
  assert.ok(button('hermes.scanGenerate'));
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  await click(button('hermes.scanGenerate'));
  assert.equal(actions('beginSetup').length, 1);
  assert.equal(container.querySelector('[data-hermes-setup]').dataset.setupState, 'generating');
});

test('refresh uses a new QR payload and timed-out setup hides the old code before retry', async () => {
  current = qrSnapshot({ setup: qrSetup });
  handler = async (name, args) => args?.action === 'beginSetup'
    ? qrSnapshot({ setup: { ...qrSetup, id: 'qr-two', qrPayload: 'https://work.weixin.qq.com/ccem-fixture-two' } }) : structuredClone(current);
  await mountQr();
  const firstQr = container.querySelector('svg[data-hermes-qr]').innerHTML;
  await click(button('hermes.scanRefresh'));
  assert.notEqual(container.querySelector('svg[data-hermes-qr]').innerHTML, firstQr);
  current = qrSnapshot({ setup: { ...qrSetup, id: 'qr-two', expiresAt: Date.now() - 1000 } });
  await poll();
  assert.equal(container.querySelector('[data-hermes-setup]').dataset.setupState, 'expired');
  assert.equal(container.querySelector('svg[data-hermes-qr]'), null);
  assert.ok(container.textContent.includes('hermes.scanExpired'));
  await click(button('hermes.scanRetry'));
  assert.equal(actions('beginSetup').length, 2);
});

test('the client stops showing a QR after five minutes even while a status read hangs', async (context) => {
  const startedAt = Date.now();
  context.mock.method(Date, 'now', () => startedAt);
  current = qrSnapshot({ setup: { ...qrSetup, expiresAt: undefined } });
  await mountQr();
  assert.ok(container.querySelector('svg[data-hermes-qr]'));
  const hangingRead = deferred();
  handler = async () => hangingRead.promise;
  await poll();
  context.mock.method(Date, 'now', () => startedAt + 300001);
  await poll();
  assert.equal(container.querySelector('svg[data-hermes-qr]'), null);
  assert.ok(button('hermes.scanRetry'));
  await harness.act(async () => hangingRead.resolve(qrSnapshot({ setup: { ...qrSetup, expiresAt: undefined } })));
});

test('QR errors expose retry and manual fallback without prefilling any credentials', async () => {
  current = qrSnapshot({ setup: { ...qrSetup, state: 'error', qrPayload: undefined, error: 'setup_request_failed' } });
  await mountQr();
  assert.equal(container.querySelector('[role="alert"]').textContent, 'hermes.scanRequestFailed');
  assert.equal(container.textContent.includes('setup_request_failed'), false);
  assert.ok(button('hermes.scanRetry'));
  await click(button('hermes.manualConnect'));
  assert.equal(actions('cancelSetup').length, 0, 'finished errors need no cancellation');
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').value, '');
});

test('fixed setup errors render localized recovery guidance in both languages', async () => {
  const cases = [
    ['setup_request_failed', 'scanRequestFailed'],
    ['setup_invalid_response', 'scanInvalidResponse'],
    ['setup_invalid_credentials', 'scanInvalidCredentials'],
    ['setup_connection_failed', 'scanConnectionFailed'],
    ['setup_pairing_failed', 'scanPairingFailed'],
    ['setup_not_supported', 'scanNotSupported'],
    ['setup_expired', 'scanExpired'],
  ];
  current = qrSnapshot();
  await mountQr();
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(await fs.readFile(path.join(desktop, `src/locales/${lang}.json`), 'utf8'));
    globalThis.__hermesTranslate = (key) => key.split('.').reduce((value, part) => value?.[part], locale);
    for (const [code, key] of cases) {
      current = qrSnapshot({ setup: { ...qrSetup, state: 'error', qrPayload: undefined, error: code } });
      await poll();
      const alert = container.querySelector('[data-hermes-setup-error]');
      assert.equal(alert.textContent, locale.hermes[key], `${lang}: ${code} has specific recovery guidance`);
      assert.equal(container.textContent.includes(code), false);
      assert.ok(button(locale.hermes.scanRetry));
      assert.ok(button(locale.hermes.manualConnect));
    }
  }
});

test('a connected bot with failed automatic pairing offers account linking without recreating the bot', async () => {
  const locale = JSON.parse(await fs.readFile(path.join(desktop, 'src/locales/zh.json'), 'utf8'));
  globalThis.__hermesTranslate = (key) => key.split('.').reduce((value, part) => value?.[part], locale);
  current = qrSnapshot({ connections: [connection({ platform: 'wecom' })],
    setup: { ...qrSetup, state: 'error', qrPayload: undefined, error: 'setup_pairing_failed', accountRef: source.accountRef } });
  handler = async (name, args) => args?.action === 'openPairing'
    ? { ...structuredClone(current), connections: [connection({ platform: 'wecom', pairing: { code: 'RETRY123', expiresAt: Date.now() + 120000 } })] }
    : structuredClone(current);
  await mount();
  await openDetails();
  assert.equal(container.querySelector('[data-hermes-setup-error]').textContent, locale.hermes.scanPairingFailed);
  assert.ok(container.textContent.includes(locale.hermes.newPairing));
  assert.equal(container.querySelector('[data-hermes-setup]'), null);
  assert.equal(container.querySelector('svg[data-hermes-qr]'), null);
  for (const label of ['scanGenerate', 'scanRefresh', 'scanRetry']) assert.equal(button(locale.hermes[label]), undefined);
  await click(button(locale.hermes.newPairing));
  assert.equal(actions('openPairing').length, 1);
  assert.equal(actions('beginSetup').length, 0, 'account-linking recovery never starts bot creation again');
  assert.equal(container.querySelector('code').textContent, '/ccem connect RETRY123');
  assert.equal(container.querySelector('[data-hermes-setup-error]'), null, 'the successful retry removes the obsolete pairing failure');
});

test('unknown setup status errors never render raw details or prefix-matched messages', async () => {
  const rawError = 'setup_request_failed: upstream rejected secret=do-not-display';
  current = qrSnapshot({ setup: { ...qrSetup, state: 'error', qrPayload: undefined, error: rawError } });
  await mountQr();
  assert.equal(container.querySelector('[role="alert"]').textContent, 'hermes.scanError');
  assert.equal(container.textContent.includes(rawError), false);
  assert.equal(container.textContent.includes('do-not-display'), false);
  assert.ok(button('hermes.scanRetry'));
});

test('begin and cancel setup failures stay local with actionable messages and safe unknown fallback', async () => {
  current = qrSnapshot();
  handler = async (name, args) => {
    if (args?.action === 'beginSetup') throw new Error('setup_busy_retry');
    if (args?.action === 'cancelSetup') throw 'setup_already_connecting';
    return structuredClone(current);
  };
  await mountQr();
  await click(button('hermes.scanGenerate'));
  assert.equal(container.querySelector('[data-hermes-setup-request-error]').textContent, 'hermes.scanBusyRetry');
  assert.equal(container.textContent.includes('setup_busy_retry'), false);
  assert.equal(button('hermes.scanGenerate').disabled, false);
  current = qrSnapshot({ setup: qrSetup });
  await poll();
  await click(button('hermes.manualConnect'));
  assert.equal(container.querySelector('[data-hermes-setup-request-error]').textContent, 'hermes.scanAlreadyConnecting');
  assert.equal(container.textContent.includes('setup_already_connecting'), false);
  assert.equal(container.querySelector('[data-hermes-manual]'), null, 'an unsuccessful cancellation never opens a conflicting configuration form');
  handler = async (name, args) => {
    if (args?.action === 'beginSetup') throw { message: 'socket failure with private-payload' };
    return structuredClone(current);
  };
  await click(button('hermes.scanRefresh'));
  assert.equal(container.querySelector('[data-hermes-setup-request-error]').textContent, 'hermes.scanError');
  assert.equal(container.textContent.includes('private-payload'), false);
});

test('connecting setup cannot be cancelled or replaced with manual configuration', async () => {
  current = qrSnapshot({ setup: { ...qrSetup, state: 'connecting', qrPayload: undefined } });
  await mountQr();
  assert.ok(container.textContent.includes('hermes.scanConnecting'));
  assert.equal(button('hermes.cancel'), undefined);
  assert.equal(button('hermes.scanRefresh'), undefined);
  assert.equal(button('hermes.manualConnect').disabled, true);
  await click(button('hermes.manualConnect'));
  assert.equal(actions('cancelSetup').length, 0);
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
});

test('a scan completing at cancellation keeps the UI in connecting state', async () => {
  current = qrSnapshot({ setup: qrSetup });
  handler = async (name, args) => args?.action === 'cancelSetup'
    ? qrSnapshot({ setup: { ...qrSetup, state: 'connecting', qrPayload: undefined } }) : structuredClone(current);
  await mountQr();
  await click(button('hermes.manualConnect'));
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.ok(container.textContent.includes('hermes.scanConnecting'));
});

test('a stale QR status cannot reopen a cancelled scan after switching to manual', async () => {
  current = qrSnapshot({ setup: qrSetup });
  await mountQr();
  const stale = deferred();
  handler = async (name, args) => name === 'hermes_status' ? stale.promise
    : qrSnapshot({ setup: { ...qrSetup, state: 'cancelled', qrPayload: undefined } });
  await poll();
  await click(button('hermes.manualConnect'));
  await harness.act(async () => stale.resolve(qrSnapshot({ setup: qrSetup })));
  assert.ok(container.querySelector('[data-hermes-manual]'));
  assert.equal(container.querySelector('[data-hermes-setup]'), null);
  await click(button('hermes.useScan'));
  assert.equal(container.querySelector('[data-hermes-setup]').dataset.setupState, 'cancelled');
});

test('QR connection advances to the backend pairing code without inventing a chat identity', async () => {
  current = qrSnapshot({ setup: qrSetup });
  await mountQr();
  current = qrSnapshot({ setup: { ...qrSetup, state: 'connected', qrPayload: undefined, accountRef: source.accountRef },
    connections: [connection({ platform: 'wecom', pairing: { code: 'NATIVE987', expiresAt: Date.now() + 120000 } })] });
  await poll();
  assert.equal(container.querySelector('[data-hermes-setup]'), null);
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.equal(container.querySelector('code').textContent, '/ccem connect NATIVE987');
  assert.equal(card(), null);
  assert.ok(container.querySelector('[data-hermes-connection-details]'));
  assert.equal(container.querySelector('[aria-current="step"]').textContent, '3hermes.stepAuthorize');
  assert.equal(actions('openPairing').length, 0, 'backend already opened the nonce; rendering does not rotate it');
  assert.equal(actions('approvePairing').length, 0);
  assert.equal(container.querySelector('[data-hermes-pairing]'), null, 'scanning is not proof of a native chat sender');
  current = { ...current, connections: [{ ...current.connections[0], pending: [{ ...pending, source: { ...source, platform: 'wecom' } }] }] };
  await poll();
  assert.ok(container.querySelector('[data-hermes-pairing="pair-one"]'));
  assert.equal(button('hermes.approvePairing').disabled, false, 'pairing does not require workspace access');
});

test('dynamic configuration sends only known fields and clears entered secrets after successful save', async () => {
  handler = async (name, args) => args?.action === 'configureChannel' ? snapshot({ configuredAccountRef: source.accountRef, connections: [connection({ configuredFields: ['DYNAMIC_ACCOUNT', 'DYNAMIC_SECRET'] })] }) : structuredClone(current);
  await mountManual();
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').type, 'password');
  assert.equal(button('hermes.saveChannel').disabled, true);
  await input('hermes-field-DYNAMIC_ACCOUNT', 'account-one');
  await input('hermes-field-DYNAMIC_SECRET', 'secret-value-123');
  await click(button('hermes.saveChannel'));
  assert.deepEqual(actions('configureChannel')[0].args.payload, { platform: 'custom-transport', fields: { DYNAMIC_ACCOUNT: 'account-one', DYNAMIC_SECRET: 'secret-value-123' } });
  assert.equal(container.textContent.includes('secret-value-123'), false);
  current = snapshot({ connections: [connection({ state: 'stopped', enabled: false, configuredFields: ['DYNAMIC_ACCOUNT', 'DYNAMIC_SECRET'] })] });
  await poll();
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET'), null, 'saved connections offer restart before configuration');
  if (button('hermes.authorizeLater')) await click(button('hermes.authorizeLater'));
  await openDetails();
  await click(button('hermes.editConnection'));
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').value, '');
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').placeholder, 'hermes.alreadyConfigured');
  assert.equal(button('hermes.saveChannel').disabled, true, 'unchanged saved settings do not revoke pairings through a redundant save');
  assert.equal(actions('start').length, 0, 'editing never reconnects with saved credentials automatically');
  await input('hermes-field-DYNAMIC_ACCOUNT', 'account-updated');
  assert.equal(button('hermes.saveChannel').disabled, false, 'partial changes keep the saved secret');
});

test('configuration errors redact entered secrets and permit a deliberate retry', async () => {
  handler = async (name, args) => { if (args?.action === 'configureChannel') throw new Error('bad credential secret-ABC'); return structuredClone(current); };
  await mountManual();
  await input('hermes-field-DYNAMIC_ACCOUNT', 'one');
  await input('hermes-field-DYNAMIC_SECRET', '  secret-ABC  ');
  await click(button('hermes.saveChannel'));
  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert.textContent.includes('••••••'));
  assert.equal(alert.textContent.includes('secret-ABC'), false);
  assert.equal(button('hermes.saveChannel').disabled, false);
});

test('stopping the channel reloads editable metadata without reconnecting or entering saved secrets', async () => {
  const configured = { configuredFields: ['DYNAMIC_ACCOUNT', 'DYNAMIC_SECRET'] };
  current = snapshot({ connections: [connection(configured)] });
  handler = async (name, args) => args?.action === 'stop'
    ? snapshot({ connections: [connection({ ...configured, state: 'stopping' })] }) : structuredClone(current);
  await mount();
  await openDetails();
  await click(button('hermes.stop'));
  assert.equal(actions('stop').length, 1);
  assert.equal(button('hermes.start').disabled, true);
  current = snapshot({ connections: [connection({ ...configured, state: 'stopped', enabled: false })] });
  await poll();
  if (button('hermes.authorizeLater')) await click(button('hermes.authorizeLater'));
  await openDetails();
  await click(button('hermes.editConnection'));
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
  await addBot();
  await click(button('hermes.otherChannels 1'));
  assert.equal(container.querySelector('[data-hermes-platform] button').disabled, true);
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.equal(button('hermes.start'), undefined);
  assert.equal(actions().length, 0);
});

test('pairing approval binds the displayed recipient and explicitly selected workspaces with input off by default', async () => {
  current = snapshot({ connections: [connection({ pending: [pending] })] });
  const approval = deferred();
  handler = async (name, args) => args?.action === 'approvePairing' ? approval.promise : structuredClone(current);
  await mount();
  await openDetails();
  assert.ok(container.textContent.includes('actual-user'));
  assert.ok(container.textContent.includes('actual-chat'));
  assert.ok(container.textContent.includes('actual-thread'));
  assert.ok(container.querySelector('[title="bot-account-reference-one"]'), 'the displayed recipient keeps its bot account reference available');
  assert.equal(button('hermes.approvePairing').disabled, false, 'workspace access is optional');
  assert.equal(container.querySelector('[aria-label="hermes.allowInput"]').getAttribute('aria-checked'), 'false');
  await click(container.querySelector('[aria-label="/projects/one"]'));
  const approve = button('hermes.approvePairing');
  await harness.act(async () => { approve.click(); approve.click(); });
  assert.equal(actions('approvePairing').length, 1);
  assert.deepEqual(actions('approvePairing')[0].args.payload, { accountRef: source.accountRef, id: 'pair-one', workspaces: ['/projects/one'], allowInput: false, notifications: true });
  await harness.act(async () => approval.resolve(snapshot({ connections: [connection()],
    routes: [{ id: 'route-one', generation: 1, source, workspaces: ['/projects/one'], enabled: true, allowInput: false, notifications: true }] })));
  assert.ok(button('hermes.disableRoute'));
});

test('workspace search keeps hidden selections while confirming from a large workspace list', async () => {
  current = snapshot({ connections: [connection({ pending: [pending] })],
    workspaces: Array.from({ length: 515 }, (_, index) => `/projects/workspace-${index}`) });
  await mount();
  await openDetails();
  await click(container.querySelector('[aria-label="/projects/workspace-0"]'));
  await input(`hermes-workspace-search-${source.accountRef}-pair-one`, 'WORKSPACE-514');
  assert.equal(container.querySelector('[aria-label="/projects/workspace-0"]'), null);
  await click(container.querySelector('[aria-label="/projects/workspace-514"]'));
  assert.ok(container.textContent.includes('hermes.selectedWorkspaces 2'));
  await input(`hermes-workspace-search-${source.accountRef}-pair-one`, 'no matching project');
  assert.ok(container.textContent.includes('hermes.noMatchingWorkspaces'));
  assert.equal(button('hermes.approvePairing').disabled, false, 'filtering does not clear the selected workspaces');
  await input(`hermes-workspace-search-${source.accountRef}-pair-one`, '');
  assert.equal(container.querySelector('[aria-label="/projects/workspace-0"]').getAttribute('aria-checked'), 'true');
  assert.equal(container.querySelector('[aria-label="/projects/workspace-514"]').getAttribute('aria-checked'), 'true');
  await click(button('hermes.approvePairing'));
  assert.deepEqual(actions('approvePairing')[0].args.payload.workspaces, ['/projects/workspace-0', '/projects/workspace-514']);
});

test('expired pending pairing cannot be approved', async () => {
  current = snapshot({ connections: [connection({ pending: [{ ...pending, expiresAt: Date.now() - 10000 }] })] });
  await mount();
  await openDetails();
  assert.equal(button('hermes.pairingExpired').disabled, true);
  assert.equal(container.querySelector('[aria-label="/projects/one"]').disabled, true);
  assert.equal(actions('approvePairing').length, 0);
});

test('new pairing displays and copies the exact code without approving any recipient', async () => {
  current = snapshot({ connections: [connection()] });
  handler = async (name, args) => args?.action === 'openPairing'
    ? { ...structuredClone(current), connections: [connection({ pairing: { code: 'ABCD1234', expiresAt: Date.now() + 600000 } })] }
    : structuredClone(current);
  let copied;
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { copied = value; } } });
  await mount();
  await openDetails();
  await click(button('hermes.newPairing'));
  assert.equal(container.querySelector('code').textContent, '/ccem connect ABCD1234');
  await click(container.querySelector('[aria-label="hermes.copyCommand"]'));
  assert.equal(copied, '/ccem connect ABCD1234');
  assert.equal(actions('approvePairing').length, 0);
});

test('disabling a route submits its exact ID and waits for the returned disabled state', async () => {
  const route = { id: 'route-to-disable', generation: 1, source, workspaces: ['/projects/one'], enabled: true, allowInput: true, notifications: true };
  current = snapshot({ connections: [connection()], routes: [route] });
  const result = deferred();
  handler = async (name, args) => args?.action === 'disableRoute' ? result.promise : structuredClone(current);
  await mount();
  await openDetails();
  await click(button('hermes.disableRoute'));
  assert.deepEqual(actions('disableRoute')[0].args.payload, { id: 'route-to-disable' });
  assert.equal(button('hermes.disableRoute').disabled, true);
  assert.equal(button('hermes.routeDisabled'), undefined);
  await harness.act(async () => result.resolve(snapshot({ connections: [connection()], routes: [{ ...route, enabled: false }] })));
  assert.equal(button('hermes.routeDisabled').disabled, true);
});

test('a failed status read recovers on refresh without leaving a stale error visible', async () => {
  handler = async () => { throw new Error('status transport unavailable'); };
  await mount();
  assert.ok(container.querySelector('[role="alert"]').textContent.includes('status transport unavailable'));
  handler = async () => structuredClone(current);
  await click(container.querySelector('[aria-label="hermes.refresh"]'));
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.ok(button('hermes.addChannel'));
});

test('installed component with no configured channel can restart metadata loading after failure', async () => {
  current = snapshot({ gateway: { state: 'stopped', platforms: [], error: 'metadata startup failed' } });
  handler = async (name, args) => args?.action === 'refreshPlatforms' ? snapshot({ gateway: { state: 'starting', platforms: [] } }) : structuredClone(current);
  await mount();
  await addBot();
  assert.equal(button('hermes.loadPlatforms').disabled, false);
  await click(button('hermes.loadPlatforms'));
  assert.deepEqual(actions('refreshPlatforms')[0].args, { action: 'refreshPlatforms' });
  assert.equal(button('hermes.loadPlatforms').disabled, true);
  current = snapshot({ gateway: { state: 'unconfigured', platforms: [platform] } });
  await poll();
  await selectPlatform(platform.id);
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
  handler = async (name) => name === 'hermes_status' ? stale.promise : snapshot({ connections: [connection()] });
  await poll();
  // Existing configuration is set via a regular status update before starting a
  // later action; here removeRuntime is available without a configured channel.
  await click(button('hermes.removeComponent'));
  await harness.act(async () => stale.resolve(snapshot({ installer: { state: 'not_installed', downloadedBytes: 0, retryable: false } })));
  assert.ok(button('hermes.stop', await openDetails()), 'new action status survives the older read');
  assert.equal(button('hermes.install'), undefined);
});

test('status polling separates completed operations from unknown delivery even with an invalid timestamp', async () => {
  await mount();
  current = snapshot({ operations: [{ id: 'operation', runtimeId: 'native-one', state: 'completed', detail: 'task finished', updatedAt: Date.now() }],
    deliveries: [{ id: 'delivery', status: 'unknown', createdAt: 'unavailable' }] });
  await poll();
  assert.ok([...container.querySelectorAll('span')].some((node) => node.textContent === 'completed'));
  assert.ok([...container.querySelectorAll('span')].some((node) => node.textContent === 'unknown'));
  assert.ok(container.textContent.includes('hermes.operations'));
  assert.ok(container.textContent.includes('hermes.deliveries'));
});

test('the runtime catalog shows supported channels first and keeps unavailable channels discoverable', async () => {
  const telegram = { ...platform, id: 'telegram', label: 'Telegram', commandPrefix: '/ccem' };
  const feishu = { ...platform, id: 'feishu', label: 'Feishu', available: false, unavailableReason: 'dependency_missing' };
  const discord = { ...platform, id: 'discord', label: 'Discord' };
  const slack = { ...platform, id: 'slack', label: 'Slack', commandPrefix: '!ccem' };
  const others = Array.from({ length: 30 }, (_, index) => ({ ...platform, id: `other-${index}`, label: `Other ${index}`, strictSend: false, unavailableReason: 'integration_unsupported' }));
  current = snapshot({ gateway: { state: 'ready', platforms: [qrPlatform, telegram, feishu, discord, slack, ...others] } });
  await mount();
  await addBot();
  assert.equal(container.querySelectorAll('[data-hermes-platform]').length, 5);
  assert.ok(container.textContent.includes('Telegram'));
  const missing = container.querySelector('[data-hermes-platform="feishu"]');
  assert.ok(missing.textContent.includes('hermes.platformDependenciesMissing'));
  assert.equal(missing.querySelector('button').disabled, true);
  await click(missing.querySelector('button'));
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  await click(button('hermes.otherChannels 30'));
  assert.equal(container.querySelectorAll('[data-hermes-platform]').length, 35);
  const search = container.querySelector('[aria-label="hermes.searchChannels"]');
  await harness.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(search, 'Other 29');
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const unsupported = container.querySelector('[data-hermes-platform="other-29"]');
  assert.ok(unsupported.textContent.includes('hermes.platformUnsupported'));
  assert.equal(unsupported.querySelector('button').disabled, true);
  assert.equal(container.querySelector('[data-hermes-platform="other-28"]'), null);
  await selectPlatform('telegram');
  assert.ok(container.querySelector('[data-hermes-manual]'));
  assert.equal(container.querySelector('[data-hermes-setup]'), null);
  assert.equal(actions().length, 0);
});

test('adding a named manual connection preserves two existing accounts on the same platform', async () => {
  const one = connection();
  const two = connection({ accountRef: 'account-two', label: 'Transport two' });
  current = snapshot({ connections: [one, two] });
  handler = async (name, args) => args?.action === 'configureChannel'
    ? snapshot({ configuredAccountRef: 'account-three', connections: [one, two, connection({ accountRef: 'account-three', label: 'Third bot' })] }) : structuredClone(current);
  await mount();
  assert.equal(container.querySelectorAll('[data-hermes-connection]').length, 2);
  await click(button('hermes.addChannel'));
  await selectPlatform(platform.id);
  await input('hermes-connection-label', 'Third bot');
  await input('hermes-field-DYNAMIC_ACCOUNT', 'third-account');
  await input('hermes-field-DYNAMIC_SECRET', 'third-secret');
  await click(button('hermes.saveChannel'));
  assert.deepEqual(actions('configureChannel')[0].args.payload, { platform: platform.id, label: 'Third bot', fields: { DYNAMIC_ACCOUNT: 'third-account', DYNAMIC_SECRET: 'third-secret' } });
  assert.ok(container.querySelector('[data-hermes-connection-details="account-three"]'));
  await click(button('hermes.authorizeLater'));
  assert.equal(container.querySelectorAll('[data-hermes-connection]').length, 3);
  assert.ok(button('hermes.stop', await openDetails(one.accountRef)));
  assert.ok(button('hermes.stop', await openDetails(two.accountRef)));
  assert.equal(container.querySelector('[data-hermes-editor]'), null);
  assert.equal(actions('stop').length, 0);
});

test('stopping and restarting one account leaves another account running', async () => {
  const one = connection();
  const two = connection({ accountRef: 'account-two', label: 'Transport two' });
  current = snapshot({ connections: [one, two] });
  handler = async (name, args) => {
    if (args?.action === 'stop') return snapshot({ connections: [{ ...one, state: 'stopped', enabled: false }, two] });
    if (args?.action === 'start') return snapshot({ connections: [one, two] });
    return structuredClone(current);
  };
  await mount();
  await click(button('hermes.stop', await openDetails(one.accountRef)));
  assert.deepEqual(actions('stop')[0].args.payload, { accountRef: one.accountRef });
  assert.ok(button('hermes.start', await openDetails(one.accountRef)));
  assert.ok(button('hermes.stop', await openDetails(two.accountRef)));
  await click(button('hermes.start', await openDetails(one.accountRef)));
  assert.deepEqual(actions('start')[0].args.payload, { accountRef: one.accountRef });
  assert.ok(button('hermes.stop', await openDetails(two.accountRef)));
});

test('editing one account preserves its draft across polling and never submits another account reference', async () => {
  const fields = ['DYNAMIC_ACCOUNT', 'DYNAMIC_SECRET'];
  const one = connection({ configuredFields: fields });
  const two = connection({ accountRef: 'account-two', label: 'Transport two', configuredFields: fields });
  current = snapshot({ connections: [one, two] });
  handler = async (name, args) => args?.action === 'configureChannel'
    ? snapshot({ connections: [connection({ ...one, accountRef: 'rotated-account-one' }), two] }) : structuredClone(current);
  await mount();
  await click(button('hermes.editConnection', await openDetails(one.accountRef)));
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').placeholder, 'hermes.alreadyConfigured');
  assert.equal(button('hermes.saveChannel').disabled, true);
  await input('hermes-field-DYNAMIC_ACCOUNT', 'edited-account');
  await poll();
  assert.equal(document.getElementById('hermes-field-DYNAMIC_ACCOUNT').value, 'edited-account');
  await click(button('hermes.saveChannel'));
  assert.deepEqual(actions('configureChannel')[0].args.payload, { accountRef: one.accountRef, platform: platform.id, label: one.label, fields: { DYNAMIC_ACCOUNT: 'edited-account' } });
  assert.equal(card(one.accountRef), null);
  assert.ok(card('rotated-account-one'));
  assert.ok(button('hermes.stop', await openDetails(two.accountRef)));
  assert.equal(actions('stop').length, 0);
});

test('switching between account editors does not move credential drafts between accounts', async () => {
  const configuredFields = ['DYNAMIC_ACCOUNT', 'DYNAMIC_SECRET'];
  current = snapshot({ connections: [connection({ configuredFields }), connection({ accountRef: 'account-two', label: 'Second', configuredFields })] });
  await mount();
  await openDetails();
  await click(button('hermes.editConnection', await openDetails()));
  await input('hermes-field-DYNAMIC_SECRET', 'first-account-secret-draft');
  await click(button('hermes.editConnection', await openDetails('account-two')));
  assert.equal(container.querySelector('[data-hermes-manual]').dataset.accountRef, 'account-two');
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').value, '');
  assert.equal(document.getElementById('hermes-connection-label').value, 'Second');
  assert.equal(button('hermes.saveChannel').disabled, true);
  assert.equal(actions('configureChannel').length, 0);
});

test('removal requires local confirmation and removes only the selected connection after its response', async () => {
  const one = connection();
  const two = connection({ accountRef: 'account-two', label: 'Second' });
  current = snapshot({ connections: [one, two] });
  const removal = deferred();
  handler = async (name, args) => args?.action === 'removeChannel' ? removal.promise : structuredClone(current);
  await mount();
  await click(button('hermes.removeChannel', await openDetails(one.accountRef)));
  assert.equal(actions('removeChannel').length, 0);
  await click(button('hermes.cancel', await openDetails(one.accountRef)));
  assert.equal(card(one.accountRef).querySelector('[data-hermes-remove-confirmation]'), null);
  await click(button('hermes.removeChannel', await openDetails(one.accountRef)));
  await click(button('hermes.confirmRemoveChannel', await openDetails(one.accountRef)));
  assert.deepEqual(actions('removeChannel')[0].args.payload, { accountRef: one.accountRef });
  assert.equal(container.querySelectorAll('[data-hermes-connection]').length, 2, 'the pending request does not remove local evidence of the connection');
  await harness.act(async () => removal.resolve(snapshot({ connections: [two] })));
  assert.equal(card(one.accountRef), null);
  assert.ok(button('hermes.stop', await openDetails(two.accountRef)));
  assert.equal(actions('stop').length, 0);
});

test('pairing commands and pending requests stay scoped to their connection even when IDs repeat', async () => {
  const one = connection({ pending: [pending], pairing: { code: 'ONECODE', expiresAt: Date.now() + 120000 } });
  const secondSource = { ...source, accountRef: 'account-two', userId: 'second-user', chatId: 'second-chat' };
  const two = connection({ accountRef: 'account-two', label: 'Second', pending: [{ ...pending, source: secondSource }], pairing: { code: 'TWOCODE', expiresAt: Date.now() + 120000 } });
  current = snapshot({ connections: [one, two], pairing: { code: 'IGNORED-LEGACY', expiresAt: Date.now() + 120000 }, pending: [{ ...pending, id: 'ignored-legacy' }] });
  await mount();
  await openDetails();
  assert.equal((await openDetails()).querySelector('code').textContent, '/ccem connect ONECODE');
  assert.equal((await openDetails('account-two')).querySelector('code').textContent, '/ccem connect TWOCODE');
  assert.equal(container.textContent.includes('IGNORED-LEGACY'), false);
  assert.equal(container.querySelector('[data-hermes-pairing="ignored-legacy"]'), null);
  await openDetails();
  assert.ok(document.getElementById(`hermes-workspace-search-${one.accountRef}-pair-one`));
  assert.equal(button('hermes.approvePairing').disabled, false, 'workspace access is optional');
  await openDetails('account-two');
  assert.ok(document.getElementById('hermes-workspace-search-account-two-pair-one'));
  await click((await openDetails('account-two')).querySelector('[aria-label="/projects/two"]'));
  await click(button('hermes.approvePairing', await openDetails('account-two')));
  assert.deepEqual(actions('approvePairing')[0].args.payload, { accountRef: 'account-two', id: 'pair-one', workspaces: ['/projects/two'], allowInput: false, notifications: true });
});

test('Slack pairing uses its runtime command prefix for both display and clipboard', async () => {
  const slack = { ...platform, id: 'slack', label: 'Slack', commandPrefix: '!ccem' };
  const slackConnection = connection({ platform: 'slack', pairing: { code: 'SLACK123', expiresAt: Date.now() + 120000 } });
  current = snapshot({ gateway: { state: 'ready', platforms: [slack] }, connections: [slackConnection] });
  let copied;
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { copied = value; } } });
  await mount();
  await openDetails();
  assert.equal((await openDetails()).querySelector('code').textContent, '!ccem connect SLACK123');
  await click((await openDetails()).querySelector('[aria-label="hermes.copyCommand"]'));
  assert.equal(copied, '!ccem connect SLACK123');
  await click(button('hermes.newPairing', await openDetails()));
  assert.deepEqual(actions('openPairing')[0].args.payload, { accountRef: source.accountRef });
});

test('switching platforms cancels a pending QR setup before showing the registry again', async () => {
  const telegram = { ...platform, id: 'telegram', label: 'Telegram' };
  current = snapshot({ gateway: { state: 'ready', platforms: [qrPlatform, telegram] }, setup: qrSetup });
  const cancellation = deferred();
  handler = async (name, args) => args?.action === 'cancelSetup' ? cancellation.promise : structuredClone(current);
  await mount();
  await click(button('hermes.changePlatform'));
  assert.equal(container.querySelector('[data-hermes-channel-picker]'), null);
  assert.deepEqual(actions('cancelSetup')[0].args.payload, { id: qrSetup.id });
  await harness.act(async () => cancellation.resolve({ ...current, setup: { ...qrSetup, state: 'cancelled', qrPayload: undefined } }));
  assert.ok(container.querySelector('[data-hermes-channel-picker]'));
  await selectPlatform('telegram');
  assert.ok(container.querySelector('[data-hermes-manual]'));
  assert.equal(container.querySelector('[data-hermes-setup]'), null);
});

test('Telegram scan setup identifies the platform and service and keeps a manual fallback', async () => {
  const telegram = { ...platform, id: 'telegram', label: 'Telegram', qrSetup: true, setupService: 'Hermes' };
  const setup = { ...qrSetup, platform: 'telegram', qrPayload: 'https://t.me/fixture-bot' };
  current = snapshot({ gateway: { state: 'ready', platforms: [qrPlatform, telegram] } });
  handler = async (name, args) => {
    if (args?.action === 'beginSetup') return { ...current, setup };
    if (args?.action === 'cancelSetup') return { ...current, setup: { ...setup, state: 'cancelled', qrPayload: undefined } };
    return structuredClone(current);
  };
  await mount();
  await selectPlatform('telegram');
  assert.ok(container.textContent.includes('hermes.scanTitle Telegram'));
  assert.equal(container.querySelector('[data-hermes-setup-service]').textContent, 'hermes.scanServiceNotice Hermes');
  await click(button('hermes.scanGenerate'));
  assert.deepEqual(actions('beginSetup')[0].args.payload, { platform: 'telegram' });
  assert.equal(container.querySelector('svg[data-hermes-qr]').getAttribute('aria-label'), 'hermes.scanQrLabel Telegram');
  assert.ok(container.textContent.includes('hermes.scanWaiting Telegram'));
  await click(button('hermes.manualConnect'));
  assert.deepEqual(actions('cancelSetup')[0].args.payload, { id: setup.id });
  assert.ok(container.querySelector('[data-hermes-manual]'));
  assert.equal(container.querySelector('svg[data-hermes-qr]'), null);
  await click(button('hermes.useScan'));
  assert.ok(container.textContent.includes('hermes.scanTitle Telegram'));
  assert.equal(actions('approvePairing').length, 0);
});

test('Feishu defaults to scanning, retries an expired code, and cancels before showing manual credentials', async () => {
  const feishu = { ...platform, id: 'feishu', label: 'Feishu', qrSetup: true, fields: [
    { key: 'FEISHU_APP_ID', label: 'App ID', secret: false, required: true },
    { key: 'FEISHU_APP_SECRET', label: 'App secret', secret: true, required: true },
    { key: 'FEISHU_DOMAIN', label: 'Region', secret: false, required: false },
  ] };
  let setup = { ...qrSetup, platform: 'feishu', qrPayload: 'https://open.feishu.cn/page/launcher?user_code=synthetic' };
  current = snapshot({ gateway: { state: 'ready', platforms: [qrPlatform, feishu] } });
  handler = async (name, args) => {
    if (args?.action === 'beginSetup') return { ...current, setup };
    if (args?.action === 'cancelSetup') return { ...current, setup: { ...setup, state: 'cancelled', qrPayload: undefined } };
    return structuredClone(current);
  };
  await mount();
  await selectPlatform('feishu');
  assert.ok(container.querySelector('[data-hermes-setup]'));
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  await click(button('hermes.scanGenerate'));
  assert.deepEqual(actions('beginSetup')[0].args.payload, { platform: 'feishu' });
  assert.ok(container.querySelector('svg[data-hermes-qr]'));
  assert.equal(container.querySelector('[data-hermes-setup-service]'), null);
  current = { ...current, setup: { ...setup, state: 'expired', qrPayload: undefined } };
  await poll();
  assert.equal(container.querySelector('svg[data-hermes-qr]'), null);
  assert.ok(button('hermes.scanRetry'));
  setup = { ...setup, id: 'feishu-new-code', qrPayload: 'https://open.feishu.cn/page/launcher?user_code=refreshed' };
  await click(button('hermes.scanRetry'));
  assert.ok(container.querySelector('svg[data-hermes-qr]'));
  await click(button('hermes.manualConnect'));
  assert.deepEqual(actions('cancelSetup').at(-1).args.payload, { id: 'feishu-new-code' });
  assert.equal(container.querySelector('svg[data-hermes-qr]'), null);
  assert.ok(container.querySelector('#hermes-field-FEISHU_APP_ID'));
  assert.equal(container.querySelector('#hermes-field-FEISHU_APP_SECRET').type, 'password');
  await click(button('hermes.useScan'));
  assert.ok(container.querySelector('[data-hermes-setup]'));
  assert.equal(actions('configureChannel').length, 0);
  assert.equal(actions('approvePairing').length, 0);
});

test('Telegram QR success adds a third connection without changing or authorizing the existing accounts', async () => {
  const telegram = { ...platform, id: 'telegram', label: 'Telegram', qrSetup: true, setupService: 'Hermes' };
  const one = connection();
  const two = connection({ accountRef: 'account-two', label: 'Second' });
  const setup = { ...qrSetup, platform: 'telegram', qrPayload: 'https://t.me/fixture-bot' };
  current = snapshot({ gateway: { state: 'ready', platforms: [platform, telegram] }, connections: [one, two] });
  handler = async (name, args) => args?.action === 'beginSetup' ? { ...current, setup } : structuredClone(current);
  await mount();
  await click(button('hermes.addChannel'));
  await selectPlatform('telegram');
  await click(button('hermes.scanGenerate'));
  const third = connection({ accountRef: 'telegram-third', platform: 'telegram', label: 'Personal Telegram', pairing: { code: 'TGPAIR', expiresAt: Date.now() + 120000 } });
  current = { ...current, connections: [one, two, third], setup: { ...setup, state: 'connected', accountRef: third.accountRef, qrPayload: undefined } };
  await poll();
  assert.equal(container.querySelector('code').textContent, '/ccem connect TGPAIR');
  assert.equal(card(), null);
  await click(button('hermes.authorizeLater'));
  assert.equal(container.querySelectorAll('[data-hermes-connection]').length, 3);
  assert.ok(button('hermes.stop', await openDetails(one.accountRef)));
  assert.ok(button('hermes.stop', await openDetails(two.accountRef)));
  assert.equal((await openDetails(third.accountRef)).querySelector('code').textContent, '/ccem connect TGPAIR');
  assert.equal(container.querySelector('[data-hermes-editor]'), null);
  assert.equal(container.querySelector('[data-hermes-pairing]'), null);
  assert.equal(actions('approvePairing').length, 0);
  assert.equal(actions('stop').length, 0);
});

test('optional schema fields do not block adding a channel and are sent only when entered', async () => {
  const optional = { ...platform, fields: [...platform.fields, { key: 'OPTIONAL_VALUE', label: 'Optional setting', secret: false, required: false }] };
  current = snapshot({ gateway: { state: 'ready', platforms: [optional] } });
  await mountManual();
  await input('hermes-field-DYNAMIC_ACCOUNT', 'account');
  await input('hermes-field-DYNAMIC_SECRET', 'secret');
  assert.equal(button('hermes.saveChannel').disabled, false);
  await click(button('hermes.saveChannel'));
  assert.equal('OPTIONAL_VALUE' in actions('configureChannel')[0].args.payload.fields, false);
});

test('editing a connection whose schema is unavailable never turns into adding a different platform', async () => {
  current = snapshot({ connections: [connection({ platform: 'old-platform' })] });
  await mount();
  await click(button('hermes.editConnection', await openDetails()));
  assert.ok(container.textContent.includes('hermes.connectionSchemaUnavailable'));
  assert.equal(container.querySelector('[data-hermes-channel-picker]'), null);
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  await click(button('hermes.loadPlatforms'));
  assert.deepEqual(actions('refreshPlatforms')[0].args, { action: 'refreshPlatforms' });
  assert.equal(actions('configureChannel').length, 0);
});

test('connecting and reconnecting accounts remain individually stoppable and removable', async () => {
  const two = connection({ accountRef: 'account-two', label: 'Second' });
  current = snapshot({ connections: [connection({ state: 'starting' }), two] });
  handler = async (name, args) => args?.action === 'stop'
    ? snapshot({ connections: [connection({ state: 'stopped', enabled: false }), two] }) : structuredClone(current);
  await mount();
  for (const state of ['starting', 'configuring', 'reconnecting']) {
    current = snapshot({ connections: [connection({ state }), two] });
    await poll();
    assert.equal(button('hermes.stop', await openDetails()).disabled, false, `${state} can be stopped`);
    assert.equal(button('hermes.editConnection', await openDetails()).disabled, true, `${state} cannot be edited`);
    assert.equal(button('hermes.removeChannel', await openDetails()).disabled, false, `${state} can be removed`);
    await click(button('hermes.stop', await openDetails()));
    assert.deepEqual(actions('stop').at(-1).args.payload, { accountRef: source.accountRef });
    assert.ok(button('hermes.stop', await openDetails('account-two')));
  }
  current = snapshot({ connections: [connection({ state: 'reconnecting' }), two] });
  await poll();
  await click(button('hermes.removeChannel', await openDetails()));
  await click(button('hermes.confirmRemoveChannel', await openDetails()));
  assert.deepEqual(actions('removeChannel')[0].args.payload, { accountRef: source.accountRef });
});

test('default WeCom and Feishu names are localized while custom connection names and stable references remain visible', async () => {
  const locale = JSON.parse(await fs.readFile(path.join(desktop, 'src/locales/zh.json'), 'utf8'));
  globalThis.__hermesTranslate = (key) => key.split('.').reduce((value, part) => value?.[part], locale);
  const feishu = { ...platform, id: 'feishu', label: 'Feishu' };
  current = snapshot({ gateway: { state: 'ready', platforms: [qrPlatform, feishu] }, connections: [
    connection({ platform: 'wecom', label: 'wecom' }),
    connection({ accountRef: 'feishu-reference', platform: 'feishu', label: 'Feishu' }),
    connection({ accountRef: 'named-reference', platform: 'wecom', label: '我的开发助手' }),
  ] });
  await mount();
  assert.equal(card().querySelector('h4').textContent, '企业微信');
  assert.equal(card('feishu-reference').querySelector('h4').textContent, '飞书');
  assert.equal(card('named-reference').querySelector('h4').textContent, '我的开发助手');
  assert.equal(card().querySelector(`[title="${source.accountRef}"]`).textContent, source.accountRef.slice(-8));
  await click(button(locale.hermes.addChannel));
  assert.ok(container.querySelector('[data-hermes-platform="wecom"]').textContent.includes('企业微信'));
  assert.ok(container.querySelector('[data-hermes-platform="feishu"]').textContent.includes('飞书'));
});

test('the setup guide retains its HTTPS href and opens through the real shell plugin IPC boundary', async () => {
  const setupUrl = 'https://docs.example.com/channel/setup?section=bot';
  current = snapshot({ gateway: { state: 'ready', platforms: [{ ...platform, setupUrl }] } });
  await mountManual();
  const link = container.querySelector('[data-hermes-manual] a');
  assert.equal(link.getAttribute('href'), setupUrl, 'the destination stays copyable');
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  await harness.act(async () => { link.dispatchEvent(event); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(event.defaultPrevented, true, 'the Tauri webview must not navigate');
  assert.deepEqual(invokeCalls.filter((call) => call.name === 'plugin:shell|open'), [{ name: 'plugin:shell|open', args: { path: setupUrl, with: undefined } }]);
});

test('a failed setup guide launch is visible and a successful retry clears the error', async () => {
  const setupUrl = 'https://docs.example.com/channel/setup';
  current = snapshot({ gateway: { state: 'ready', platforms: [{ ...platform, setupUrl }] } });
  let fail = true;
  handler = async (name) => {
    if (name === 'plugin:shell|open' && fail) throw new Error('Browser launch unavailable');
    return structuredClone(current);
  };
  await mountManual();
  const link = container.querySelector('[data-hermes-manual] a');
  await click(link);
  assert.ok(container.querySelector('[role="alert"]').textContent.includes('Browser launch unavailable'));
  assert.equal(link.getAttribute('href'), setupUrl);
  fail = false;
  await click(link);
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(invokeCalls.filter((call) => call.name === 'plugin:shell|open').length, 2);
});

test('unsafe setup guide URLs never become links or reach shell IPC', async () => {
  const invalid = ['http://docs.example.com/setup', 'javascript:alert(1)', 'file:///tmp/guide', 'https://user:secret@docs.example.com/setup', 'not a URL'];
  current = snapshot({ gateway: { state: 'ready', platforms: invalid.map((setupUrl, index) => ({ ...platform, id: `unsafe-${index}`, setupUrl, available: false })) } });
  await mount();
  await addBot();
  assert.equal(container.querySelectorAll('[data-hermes-platform] a').length, 0);
  assert.equal(invokeCalls.filter((call) => call.name === 'plugin:shell|open').length, 0);
});

test('healthy runtime controls are disclosed on demand and installation failures surface automatically', async () => {
  current = snapshot({ connections: [connection()] });
  await mount();
  const trigger = container.querySelector('[aria-controls="hermes-runtime-details"]');
  const details = document.getElementById('hermes-runtime-details');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(details.hidden, true);
  await click(trigger);
  assert.equal(details.hidden, false);
  assert.equal(button('hermes.updateComponent').disabled, false);
  await click(trigger);
  assert.equal(details.hidden, true);
  current.installer = { ...current.installer, state: 'error', error: 'fixture download failed', retryable: true,
    launch: { runtimeRoot: '/fixture/runtime', python: '/fixture/python', source: '/fixture/source', host: '/fixture/host.py' } };
  await poll();
  assert.equal(details.hidden, false, 'failure cannot be hidden by the previous disclosure preference');
  assert.ok(details.querySelector('[role="alert"]').textContent.includes('fixture download failed'));
  assert.equal(button('hermes.retryInstall').disabled, false);
});

test('connection management opens in a focused drawer and Escape restores its list entry', async () => {
  current = snapshot({ connections: [connection(), connection({ accountRef: 'second-account', label: 'Second account' })] });
  await mount();
  const row = card();
  const trigger = button('hermes.connectionDetails', row);
  assert.ok(row.textContent.includes(source.accountRef.slice(-8)));
  const details = await openDetails();
  assert.equal(document.activeElement, details.querySelector('h2'));
  assert.equal(card(), row, 'opening details leaves the list DOM stable');
  assert.equal(container.querySelectorAll('[data-hermes-drawer]').length, 1);
  assert.equal(actions().length, 0);
  await harness.act(async () => { document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await settle();
  assert.equal(container.querySelector('[data-hermes-drawer]'), null);
  assert.equal(document.activeElement, trigger);
});

test('new pairing requests update the list cue without expanding or stealing focus', async () => {
  current = snapshot({ connections: [connection()] });
  await mount();
  button('hermes.addChannel').focus();
  current.connections[0].pending = [pending];
  await poll();
  assert.ok(button('hermes.pendingPairings', card()));
  assert.equal(container.querySelector('[data-hermes-pairing]'), null);
  assert.equal(document.activeElement?.hasAttribute('data-hermes-add'), true);
  const details = await openDetails();
  const request = details.querySelector('[data-hermes-pairing]');
  assert.ok(request.textContent.includes(source.userId));
  assert.ok(request.textContent.includes(source.chatId));
  assert.equal(request.querySelector('[aria-label="/projects/one"]').getAttribute('aria-checked'), 'false');
  assert.equal(request.querySelector('[aria-label="hermes.allowInput"]').getAttribute('aria-checked'), 'false');
  assert.equal(button('hermes.approvePairing', request).disabled, false);
  assert.equal(actions('approvePairing').length, 0);
});

test('Add replaces the list and legacy panels with a focused wizard, then restores list position', async () => {
  current = qrSnapshot({ connections: [connection()] });
  await mount(true);
  await click(button('hermes.existingConnections'));
  assert.ok(container.querySelector('[data-legacy-panel]'));
  mountPoint.scrollTop = 400;
  await click(button('hermes.addChannel'));
  let editor = container.querySelector('[data-hermes-editor]');
  assert.equal(card(), null);
  assert.equal(container.querySelector('[data-legacy-panel]'), null);
  assert.equal(mountPoint.scrollTop, 0);
  assert.equal(document.activeElement, editor.querySelector('h3'));
  await selectPlatform('wecom');
  editor = container.querySelector('[data-hermes-editor]');
  assert.equal(document.activeElement, editor.querySelector('h3'));
  assert.ok(editor.querySelector('[aria-current="step"]').textContent.includes('hermes.stepConnect'));
  await click(button('hermes.backToConnections'));
  assert.equal(container.querySelector('[data-hermes-editor]'), null);
  assert.equal(document.activeElement?.hasAttribute('data-hermes-add'), true);
  assert.equal(mountPoint.scrollTop, 400);
  assert.ok(container.querySelector('[data-legacy-panel]'));
  assert.equal(actions().length, 0);
});

test('closing the add flow preserves a QR on failed cancellation and closes only after successful cancellation', async () => {
  current = qrSnapshot({ connections: [connection()], setup: qrSetup });
  let cancelFails = true;
  handler = async (name, args) => {
    if (args?.action === 'cancelSetup') {
      if (cancelFails) throw new Error('setup_request_failed');
      current.setup = { ...qrSetup, state: 'cancelled', qrPayload: undefined };
    }
    return structuredClone(current);
  };
  await mount();
  await click(button('hermes.backToConnections'));
  assert.ok(container.querySelector('[data-hermes-qr]'));
  assert.ok(container.querySelector('[data-hermes-setup-request-error]'));
  assert.equal(actions('cancelSetup').length, 1);
  cancelFails = false;
  await click(button('hermes.backToConnections'));
  assert.equal(actions('cancelSetup').length, 2);
  assert.equal(container.querySelector('[data-hermes-editor]'), null);
  assert.ok(card());
});

test('manual creation advances to authorization and returning locates the new bot', async () => {
  handler = async (name, args) => args?.action === 'configureChannel'
    ? snapshot({ configuredAccountRef: source.accountRef, connections: [connection()] }) : structuredClone(current);
  await mountManual();
  await input('hermes-field-DYNAMIC_ACCOUNT', 'test-account');
  await input('hermes-field-DYNAMIC_SECRET', 'test-secret');
  await click(button('hermes.saveChannel'));
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.equal(document.activeElement?.tagName, 'H3');
  assert.ok(container.textContent.includes('hermes.authorizeConnection'));
  assert.equal(card(), null);
  await click(button('hermes.authorizeLater'));
  assert.ok(card().classList.contains('is-highlighted'));
  assert.equal(document.activeElement?.getAttribute('data-hermes-open'), source.accountRef);
});

test('manual creation uses its explicit receipt even when a different new bot appears first', async () => {
  const unrelated = connection({ accountRef: 'external-account', platform: 'slack' });
  const added = connection({ accountRef: 'our-account' });
  handler = async (name, args) => args?.action === 'configureChannel'
    ? snapshot({ configuredAccountRef: added.accountRef, connections: [unrelated, added] }) : structuredClone(current);
  await mountManual();
  await input('hermes-field-DYNAMIC_ACCOUNT', 'our-bot');
  await input('hermes-field-DYNAMIC_SECRET', 'test-secret');
  await click(button('hermes.saveChannel'));
  assert.ok(container.querySelector('[data-hermes-connection-details="our-account"]'));
  assert.equal(container.querySelector('[data-hermes-connection-details="external-account"]'), null);
});

test('manual receipt advances while a concurrent account reply and status read remain pending', async () => {
  current = snapshot({ connections: [connection()] });
  const pairing = deferred();
  const read = deferred();
  let holdRead = false;
  handler = async (name, args) => {
    if (args?.action === 'openPairing') return pairing.promise;
    if (args?.action === 'configureChannel') return snapshot({ configuredAccountRef: 'added-account', connections: [connection(), connection({ accountRef: 'added-account' })] });
    if (name === 'hermes_status' && holdRead) return read.promise;
    return structuredClone(current);
  };
  await mount();
  await click(button('hermes.newPairing', await openDetails()));
  await closeDetails();
  await selectPlatform(platform.id);
  holdRead = true;
  await poll();
  await input('hermes-field-DYNAMIC_ACCOUNT', 'new-account');
  await input('hermes-field-DYNAMIC_SECRET', 'test-secret');
  await click(button('hermes.saveChannel'));
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.equal(container.querySelector('[aria-current="step"]').textContent, '3hermes.stepAuthorize');
  current.connections.push(connection({ accountRef: 'added-account' }));
  holdRead = false;
  await harness.act(async () => read.resolve(structuredClone(current)));
  await poll();
  assert.ok(container.querySelector('[data-hermes-connection-details="added-account"]'));
  await harness.act(async () => { pairing.resolve(structuredClone(current)); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await settle();
});

test('a concurrent cancellation receipt cannot reveal manual credentials after scanning completes', async () => {
  current = qrSnapshot({ connections: [connection()] });
  const pairing = deferred();
  const read = deferred();
  let holdRead = false;
  handler = async (name, args) => {
    if (args?.action === 'openPairing') return pairing.promise;
    if (args?.action === 'beginSetup') { current.setup = qrSetup; return structuredClone(current); }
    if (args?.action === 'cancelSetup') return { ...structuredClone(current), setup: { ...qrSetup, state: 'connecting', qrPayload: undefined } };
    if (name === 'hermes_status' && holdRead) return read.promise;
    return structuredClone(current);
  };
  await mount();
  await click(button('hermes.newPairing', await openDetails()));
  await closeDetails();
  await selectPlatform('wecom');
  await click(button('hermes.scanGenerate'));
  holdRead = true;
  await poll();
  await click(button('hermes.manualConnect'));
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.equal(container.querySelector('[data-hermes-setup]').dataset.setupState, 'connecting');
  assert.equal(button('hermes.backToConnections').disabled, true);
  current = qrSnapshot({ setup: { ...qrSetup, state: 'connected', accountRef: 'scanned-account' }, connections: [connection(), connection({ accountRef: 'scanned-account', platform: 'wecom' })] });
  holdRead = false;
  await harness.act(async () => read.resolve(structuredClone(current)));
  await poll();
  assert.ok(container.querySelector('[data-hermes-connection-details="scanned-account"]'));
  await harness.act(async () => { pairing.resolve(structuredClone(current)); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await settle();
});

test('scan, native pairing and explicit authorization complete the wizard and highlight the exact bot', async () => {
  current = qrSnapshot({ setup: qrSetup });
  await mountQr();
  current.setup = { ...qrSetup, state: 'connected', accountRef: source.accountRef };
  current.connections = [connection({ platform: 'wecom', pairing: { code: 'PAIR123', expiresAt: Date.now() + 60000 } })];
  await poll();
  assert.equal(button('hermes.finishSetup'), undefined);
  assert.equal(container.querySelector('[data-hermes-pairing]'), null);
  current.connections[0].pending = [pending];
  await poll();
  assert.equal(button('hermes.approvePairing').disabled, false, 'workspace access is optional');
  await click(container.querySelector('[aria-label="/projects/one"]'));
  handler = async (name, args) => {
    if (args?.action === 'approvePairing') {
      current.routes = [{ id: 'new-route', generation: 1, source, enabled: true, workspaces: args.payload.workspaces, allowInput: args.payload.allowInput, notifications: args.payload.notifications }];
      current.connections[0].pending = [];
    }
    return structuredClone(current);
  };
  await click(button('hermes.approvePairing'));
  assert.equal(actions('approvePairing')[0].args.payload.allowInput, false);
  assert.ok(button('hermes.finishSetup'));
  assert.equal(card(), null);
  await click(button('hermes.finishSetup'));
  assert.ok(card().classList.contains('is-highlighted'));
  assert.equal(document.activeElement?.getAttribute('data-hermes-open'), source.accountRef);
  assert.ok(card().textContent.includes('hermes.accessSummary 1'));
  await click(button('hermes.addChannel'));
  assert.ok(container.querySelector('[data-hermes-channel-picker]'), 'a completed scan never reopens its prior authorization step');
});

test('an old cancellation finishing its refresh cannot replace a newer QR session with manual setup', async () => {
  current = qrSnapshot({ connections: [connection()] });
  const pairing = deferred();
  const slowRead = deferred();
  let holdRead = false;
  let generations = 0;
  handler = async (name, args) => {
    if (args?.action === 'openPairing') return pairing.promise;
    if (args?.action === 'beginSetup') { current.setup = { ...qrSetup, id: `qr-${++generations}` }; return structuredClone(current); }
    if (args?.action === 'cancelSetup') { current.setup = { ...current.setup, state: 'cancelled' }; holdRead = true; return structuredClone(current); }
    if (name === 'hermes_status' && holdRead) return slowRead.promise;
    return structuredClone(current);
  };
  await mount();
  await click(button('hermes.newPairing', await openDetails()));
  await closeDetails();
  await selectPlatform('wecom');
  await click(button('hermes.scanGenerate'));
  await click(button('hermes.manualConnect'));
  assert.equal(button('hermes.scanRefresh').disabled, false);
  await click(button('hermes.scanRefresh'));
  assert.equal(current.setup.id, 'qr-2');
  holdRead = false;
  await harness.act(async () => slowRead.resolve(structuredClone(current)));
  await settle();
  await poll();
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.equal(container.querySelector('[data-hermes-setup]').dataset.setupState, 'waiting');
  await harness.act(async () => pairing.resolve(structuredClone(current)));
  await settle();
});

for (const available of [[], ['/projects/one']]) test(`pairing completes without workspace access with ${available.length} available projects`, async () => {
  current = qrSnapshot({ setup: qrSetup, workspaces: available });
  await mountQr();
  current.setup = { ...qrSetup, state: 'connected', accountRef: source.accountRef };
  current.connections = [connection({ platform: 'wecom', pending: [pending] })];
  await poll();
  handler = async (name, args) => {
    if (args?.action === 'approvePairing') {
      current.routes = [{ id: 'unbound', generation: 1, source, enabled: true,
        workspaces: args.payload.workspaces, allowInput: args.payload.allowInput, notifications: args.payload.notifications }];
      current.connections[0].pending = [];
    }
    return structuredClone(current);
  };
  assert.equal(button('hermes.approvePairing').disabled, false);
  assert.equal(container.querySelector('[data-hermes-pairing] [data-hermes-disclosure-content]').hidden, true);
  assert.equal(container.querySelector('[aria-label="hermes.allowInput"]').disabled, true);
  assert.equal(container.querySelector('[aria-label="hermes.notifications"]').disabled, true);
  await click(button('hermes.approvePairing'));
  assert.deepEqual(actions('approvePairing')[0].args.payload, { accountRef: source.accountRef, id: pending.id, workspaces: [], allowInput: false, notifications: false });
  assert.ok(button('hermes.finishSetup'));
  await click(button('hermes.finishSetup'));
  assert.ok(card().textContent.includes('hermes.pairedWithoutWorkspace'));
  assert.equal(card().textContent.includes('hermes.queryOnly'), false);
  await openDetails();
  assert.ok(button('hermes.manageWorkspaceAccess'));
});

test('a paired bot can gain then remove all workspace access without losing its identity', async () => {
  const route = { id: 'route-one', generation: 3, source, enabled: true, workspaces: [], allowInput: false, notifications: false };
  current = snapshot({ connections: [connection()], routes: [route] });
  handler = async (name, args) => {
    if (args?.action === 'updateRoute') current.routes = [{ ...current.routes[0], ...args.payload, generation: args.payload.generation + 1 }];
    return structuredClone(current);
  };
  await mount();
  await openDetails();
  await click(button('hermes.manageWorkspaceAccess'));
  assert.equal(document.activeElement, container.querySelector('[data-hermes-route-editor]'));
  assert.equal(button('hermes.saveWorkspaceAccess').disabled, true);
  await click(container.querySelector('[aria-label="/projects/one"]'));
  await click(button('hermes.saveWorkspaceAccess'));
  assert.deepEqual(actions('updateRoute')[0].args.payload, { accountRef: source.accountRef, id: route.id, generation: 3,
    workspaces: ['/projects/one'], allowInput: false, notifications: true });
  assert.equal(container.querySelector('[data-hermes-route-editor]'), null);
  assert.equal(document.activeElement, button('hermes.manageWorkspaceAccess'));
  await click(button('hermes.manageWorkspaceAccess'));
  await click(container.querySelector('[aria-label="/projects/one"]'));
  await click(button('hermes.saveWorkspaceAccess'));
  assert.deepEqual(actions('updateRoute')[1].args.payload, { accountRef: source.accountRef, id: route.id, generation: 4,
    workspaces: [], allowInput: false, notifications: false });
  assert.ok(container.querySelector('[data-hermes-route="route-one"]'));
  assert.ok(card().textContent.includes('hermes.pairedWithoutWorkspace'));
  assert.equal(document.activeElement, button('hermes.manageWorkspaceAccess'));
});

test('editing grants preserves existing workspaces outside the current catalogue and cancel writes nothing', async () => {
  current = snapshot({ connections: [connection()], routes: [{ id: 'route-one', generation: 1, source, enabled: true,
    workspaces: ['/projects/older'], allowInput: true, notifications: false }] });
  await mount();
  await openDetails();
  await click(button('hermes.manageWorkspaceAccess'));
  assert.equal(container.querySelector('[aria-label="/projects/older"]').getAttribute('aria-checked'), 'true');
  await click(container.querySelector('[aria-label="/projects/one"]'));
  await click(button('hermes.cancel'));
  assert.equal(actions('updateRoute').length, 0);
  assert.equal(document.activeElement, button('hermes.manageWorkspaceAccess'));
  await click(button('hermes.manageWorkspaceAccess'));
  assert.equal(container.querySelector('[aria-label="/projects/one"]').getAttribute('aria-checked'), 'false');
  await click(container.querySelector('[aria-label="hermes.notifications"]'));
  await click(button('hermes.saveWorkspaceAccess'));
  assert.deepEqual(actions('updateRoute')[0].args.payload.workspaces, ['/projects/older']);
});

test('failed permission saves keep the draft, and a newer policy discards its stale generation', async () => {
  current = snapshot({ connections: [connection()], routes: [{ id: 'route-one', generation: 1, source, enabled: true,
    workspaces: [], allowInput: false, notifications: false }] });
  handler = async (name, args) => { if (args?.action === 'updateRoute') throw new Error('route_authority_changed'); return structuredClone(current); };
  await mount();
  await openDetails();
  await click(button('hermes.manageWorkspaceAccess'));
  await click(container.querySelector('[aria-label="/projects/one"]'));
  await click(button('hermes.saveWorkspaceAccess'));
  assert.ok(container.querySelector('[data-hermes-route-editor]'));
  assert.equal(container.querySelector('[aria-label="/projects/one"]').getAttribute('aria-checked'), 'true');
  assert.ok(container.querySelector('[role="alert"]').textContent.includes('route_authority_changed'));
  current.routes[0] = { ...current.routes[0], generation: 2, workspaces: ['/projects/two'] };
  await poll();
  assert.equal(container.querySelector('[data-hermes-route-editor]'), null);
  await click(button('hermes.manageWorkspaceAccess'));
  assert.equal(container.querySelector('[aria-label="/projects/one"]').getAttribute('aria-checked'), 'false');
  assert.equal(container.querySelector('[aria-label="/projects/two"]').getAttribute('aria-checked'), 'true');
  assert.equal(actions('updateRoute').length, 1);
});

test('paused connections and revoked identities cannot edit grants', async () => {
  current = snapshot({ connections: [connection({ enabled: false, state: 'stopped' })], routes: [{ id: 'route-one', generation: 1, source,
    enabled: true, workspaces: [], allowInput: false, notifications: false }] });
  await mount();
  await openDetails();
  assert.equal(button('hermes.manageWorkspaceAccess').disabled, true);
  assert.equal(button('hermes.disableRoute').disabled, false, 'access can still be revoked while stopped');
  current.routes[0] = { ...current.routes[0], enabled: false, generation: 2 };
  await poll();
  assert.equal(button('hermes.manageWorkspaceAccess'), undefined);
  assert.equal(actions('updateRoute').length, 0);
});
