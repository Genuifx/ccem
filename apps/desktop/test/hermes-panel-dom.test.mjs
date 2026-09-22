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
const qrPlatform = { ...platform, id: 'wecom', label: 'WeCom', qrSetup: true };
const qrSetup = { id: 'qr-one', platform: 'wecom', state: 'waiting', qrPayload: 'https://work.weixin.qq.com/ccem-fixture-one', expiresAt: Date.now() + 300000 };
function qrSnapshot(patch = {}) {
  return snapshot({ gateway: { state: 'unconfigured', platforms: [qrPlatform] }, ...patch });
}
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
        if (args.path === 'locale') return { contents: `export function useLocale(){return {lang:'en',t:(key,params={})=>globalThis.__hermesTranslate?.(key,params)??key+Object.values(params).map(value=>' '+value).join('')}}`, loader: 'js' };
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
  globalThis.__hermesTranslate = undefined;
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

test('QR-capable platforms default to scan setup without exposing credential fields', async () => {
  current = qrSnapshot();
  const generation = deferred();
  handler = async (name, args) => args?.action === 'beginSetup' ? generation.promise : structuredClone(current);
  await mount();
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
  assert.equal(container.querySelector('svg[aria-label="hermes.scanQrLabel"]'), null);
  current = qrSnapshot({ setup: qrSetup });
  await poll();
  const qr = container.querySelector('svg[aria-label="hermes.scanQrLabel"]');
  assert.ok(qr?.querySelector('path'), 'the received QR payload produces a real SVG QR code');
  assert.ok(container.textContent.includes('hermes.scanWaiting'));
});

test('switching to manual connection cancels the pending QR setup before revealing the form', async () => {
  current = qrSnapshot({ setup: qrSetup });
  const cancellation = deferred();
  handler = async (name, args) => args?.action === 'cancelSetup' ? cancellation.promise : structuredClone(current);
  await mount();
  await click(button('hermes.manualConnect'));
  assert.deepEqual(actions('cancelSetup')[0].args.payload, { id: 'qr-one' });
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.equal(button('hermes.manualConnect').disabled, true);
  await harness.act(async () => cancellation.resolve(qrSnapshot({ setup: { ...qrSetup, state: 'cancelled', qrPayload: undefined } })));
  assert.ok(container.querySelector('[data-hermes-manual]'));
  assert.equal(container.querySelector('svg[aria-label="hermes.scanQrLabel"]'), null);
  await input('hermes-field-DYNAMIC_ACCOUNT', 'manual-account');
  await input('hermes-field-DYNAMIC_SECRET', 'manual-secret');
  assert.equal(button('hermes.saveChannel').disabled, false);
  current = qrSnapshot({ setup: { ...qrSetup, state: 'cancelled' } });
  await poll();
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET').value, 'manual-secret', 'status polling preserves the manual draft');
  handler = async (name, args) => args?.action === 'configureChannel'
    ? qrSnapshot({ gateway: { state: 'running', platforms: [qrPlatform], configuredPlatform: 'wecom' } }) : structuredClone(current);
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
  await mount();
  await click(button('hermes.manualConnect'));
  assert.equal(container.querySelector('[role="alert"]').textContent, 'hermes.scanError');
  assert.equal(container.textContent.includes('setup cancellation unavailable'), false);
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.ok(container.querySelector('svg[aria-label="hermes.scanQrLabel"]'));
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
  await mount();
  await click(button('hermes.cancel'));
  assert.ok(container.textContent.includes('hermes.scanCancelled'));
  assert.equal(container.querySelector('svg[aria-label="hermes.scanQrLabel"]'), null);
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
  await mount();
  const firstQr = container.querySelector('svg[aria-label="hermes.scanQrLabel"]').innerHTML;
  await click(button('hermes.scanRefresh'));
  assert.notEqual(container.querySelector('svg[aria-label="hermes.scanQrLabel"]').innerHTML, firstQr);
  current = qrSnapshot({ setup: { ...qrSetup, id: 'qr-two', expiresAt: Date.now() - 1000 } });
  await poll();
  assert.equal(container.querySelector('[data-hermes-setup]').dataset.setupState, 'expired');
  assert.equal(container.querySelector('svg[aria-label="hermes.scanQrLabel"]'), null);
  assert.ok(container.textContent.includes('hermes.scanExpired'));
  await click(button('hermes.scanRetry'));
  assert.equal(actions('beginSetup').length, 2);
});

test('the client stops showing a QR after five minutes even while a status read hangs', async (context) => {
  const startedAt = Date.now();
  context.mock.method(Date, 'now', () => startedAt);
  current = qrSnapshot({ setup: { ...qrSetup, expiresAt: undefined } });
  await mount();
  assert.ok(container.querySelector('svg[aria-label="hermes.scanQrLabel"]'));
  const hangingRead = deferred();
  handler = async () => hangingRead.promise;
  await poll();
  context.mock.method(Date, 'now', () => startedAt + 300001);
  await poll();
  assert.equal(container.querySelector('svg[aria-label="hermes.scanQrLabel"]'), null);
  assert.ok(button('hermes.scanRetry'));
  await harness.act(async () => hangingRead.resolve(qrSnapshot({ setup: { ...qrSetup, expiresAt: undefined } })));
});

test('QR errors expose retry and manual fallback without prefilling any credentials', async () => {
  current = qrSnapshot({ setup: { ...qrSetup, state: 'error', qrPayload: undefined, error: 'setup_request_failed' } });
  await mount();
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
  await mount();
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
  current = qrSnapshot({ gateway: { state: 'running', platforms: [qrPlatform], configuredPlatform: 'wecom' },
    setup: { ...qrSetup, state: 'error', qrPayload: undefined, error: 'setup_pairing_failed' } });
  handler = async (name, args) => args?.action === 'openPairing'
    ? { ...structuredClone(current), pairing: { code: 'RETRY123', expiresAt: Date.now() + 120000 } }
    : structuredClone(current);
  await mount();
  assert.equal(container.querySelector('[data-hermes-setup-error]').textContent, locale.hermes.scanPairingFailed);
  assert.ok(container.textContent.includes('连接本人账号'));
  assert.equal(container.querySelector('[data-hermes-setup]'), null);
  assert.equal(container.querySelector('svg[aria-label="hermes.scanQrLabel"]'), null);
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
  await mount();
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
  await mount();
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
  await mount();
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
  await mount();
  await click(button('hermes.manualConnect'));
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.ok(container.textContent.includes('hermes.scanConnecting'));
});

test('a stale QR status cannot reopen a cancelled scan after switching to manual', async () => {
  current = qrSnapshot({ setup: qrSetup });
  await mount();
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
  await mount();
  current = qrSnapshot({ setup: { ...qrSetup, state: 'connected', qrPayload: undefined },
    gateway: { state: 'running', platforms: [qrPlatform], configuredPlatform: 'wecom' },
    pairing: { code: 'NATIVE987', expiresAt: Date.now() + 120000 } });
  await poll();
  assert.equal(container.querySelector('[data-hermes-setup]'), null);
  assert.equal(container.querySelector('[data-hermes-manual]'), null);
  assert.equal(container.querySelector('code').textContent, '/ccem connect NATIVE987');
  assert.ok(container.textContent.includes('hermes.channelConnected WeCom'));
  assert.equal(actions('openPairing').length, 0, 'backend already opened the nonce; rendering does not rotate it');
  assert.equal(actions('approvePairing').length, 0);
  assert.equal(container.querySelector('[data-hermes-pairing]'), null, 'scanning is not proof of a native chat sender');
  current = { ...current, pending: [{ ...pending, source: { ...source, platform: 'wecom' } }] };
  await poll();
  assert.ok(container.querySelector('[data-hermes-pairing="pair-one"]'));
  assert.equal(button('hermes.approvePairing').disabled, true, 'workspace authorization remains an explicit step');
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
  assert.equal(document.getElementById('hermes-field-DYNAMIC_SECRET'), null, 'saved connections offer restart before configuration');
  await click(button('hermes.editConnection'));
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
  assert.equal(button('hermes.saveChannel').disabled, true);
  assert.equal(button('hermes.start'), undefined);
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
