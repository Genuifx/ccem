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
const zhLocale = JSON.parse(await fs.readFile(path.join(desktop, 'src/locales/zh.json'), 'utf8'));

let harness;
let temp;
let dom;
let root;
let mountPoint;
let invokeCalls;
let currentStatus;
let handoffSnapshot;
let pickedFolder;
let navigatedTab;

const feishuPlatform = {
  id: 'feishu',
  label: 'Feishu',
  available: true,
  strictSend: true,
  qrSetup: false,
  fields: [
    { key: 'FEISHU_APP_ID', label: 'FEISHU_APP_ID', secret: false, required: true },
    { key: 'FEISHU_APP_SECRET', label: 'FEISHU_APP_SECRET', secret: true, required: true },
    { key: 'FEISHU_DOMAIN', label: 'FEISHU_DOMAIN', secret: false, required: false },
  ],
};

const source = {
  platform: 'feishu',
  profile: 'default',
  transportProfile: 'ws',
  accountRef: 'feishu-bot-account-01',
  userId: 'ou_abcdef1234567890abcdef',
  chatId: 'oc_chat_88889999',
  threadId: null,
  chatType: 'dm',
};

function makeStatus(patch = {}) {
  return {
    installer: { state: 'installed', version: '2026.10.2', downloadedBytes: 0, totalBytes: null, retryable: false },
    gateway: { state: 'ready', platforms: [feishuPlatform] },
    conversationModels: [{ envName: 'deepseek', model: 'deepseek-chat' }],
    unavailableModels: [{ envName: 'official', reason: 'oauth_not_supported' }],
    connections: [],
    routes: [],
    operations: [],
    deliveries: [],
    workspaces: ['/projects/alpha'],
    ...patch,
  };
}

const flush = () => harness.act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test.before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-hermes-overhaul-'));
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
    'HTMLButtonElement', 'HTMLSelectElement', 'KeyboardEvent', 'NodeFilter',
    'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'Event',
    'MouseEvent', 'CustomEvent',
  ]) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  };
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {};

  const output = path.join(temp, 'overhaul-harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { HermesPanel } from '@/components/chat-app/hermes/HermesPanel';
        import { WorkspaceHermesBindDialog, WorkspaceHermesSessionBadge } from '@/components/workspace/WorkspaceHermesBindDialog';
        import { buildMessagesFromEvents } from '@/components/workspace/workspaceEventTranscript';
        export { act, buildMessagesFromEvents };
        export function mountPanel(container) {
          const root = createRoot(container);
          act(() => root.render(React.createElement(HermesPanel)));
          return root;
        }
        export function mountHandoff(container) {
          const root = createRoot(container);
          act(() => root.render(React.createElement(WorkspaceHermesBindDialog, {
            open: true,
            onOpenChange: () => {},
            session: { runtime_id: 'rt-1', display_title: 'Refactor Hermes', project_dir: '/projects/alpha' },
            onLegacyOpen: () => {},
            onNavigateChatApp: () => globalThis.__onNavigateChatApp?.(),
          })));
          return root;
        }
        export function mountBadge(container) {
          const root = createRoot(container);
          act(() => root.render(React.createElement(WorkspaceHermesSessionBadge, {
            runtimeId: 'rt-1',
            dialogOpen: false,
            onClick: () => {},
          })));
          return root;
        }
      `,
      loader: 'tsx',
      resolveDir: desktop,
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css': 'empty' },
    plugins: [{
      name: 'Hermes UX overhaul DOM boundary',
      setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'overhaul-stub' }));
        builder.onResolve({ filter: /^@tauri-apps\/plugin-shell$/ }, () => ({ path: 'shell', namespace: 'overhaul-stub' }));
        builder.onResolve({ filter: /^@\/lib\/nativeSurfaceOcclusion$/ }, () => ({ path: 'occlusion', namespace: 'overhaul-stub' }));
        builder.onResolve({ filter: /^@\/locales$/ }, () => ({ path: 'locale', namespace: 'overhaul-stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'overhaul-stub' }, (args) => {
          if (args.path === 'ipc') {
            return { contents: 'export const invoke=(name,args)=>globalThis.__overhaulInvoke(name,args);', loader: 'js' };
          }
          if (args.path === 'shell') {
            return { contents: 'export const open=async()=>{};', loader: 'js' };
          }
          if (args.path === 'occlusion') {
            return { contents: 'export const useNativeSurfaceOcclusion=(open)=>open;', loader: 'js' };
          }
          if (args.path === 'locale') {
            return {
              contents: 'export function useLocale(){return {lang:"zh",t:(key,params={})=>globalThis.__overhaulTranslate(key,params)};}',
              loader: 'js',
            };
          }
          return null;
        });
        builder.onResolve({ filter: /^@\// }, async (args) => {
          const base = path.join(desktop, 'src', args.path.slice(2));
          for (const suffix of ['', '.ts', '.tsx', '/index.tsx']) {
            try {
              if ((await fs.stat(base + suffix)).isFile()) return { path: base + suffix };
            } catch {}
          }
          return { errors: [{ text: `Missing source ${args.path}` }] };
        });
      },
    }],
  });
  harness = require(output);
});

test.beforeEach(() => {
  invokeCalls = [];
  currentStatus = makeStatus();
  pickedFolder = '/Users/wzt/CustomRepo';
  navigatedTab = null;
  handoffSnapshot = {
    binding: null,
    bindingValid: false,
    deliveryStatus: null,
    targets: [{
      routeId: 'route-1',
      generation: 1,
      accountRef: source.accountRef,
      platform: 'feishu',
      label: '研发助手',
      chatId: source.chatId,
      userId: source.userId,
      userName: '王志腾',
      chatType: 'dm',
      handoffReady: true,
      modelEnv: 'deepseek',
    }],
    models: [{ envName: 'deepseek', model: 'deepseek-chat' }],
    defaultModelEnv: 'official',
  };
  globalThis.__onNavigateChatApp = () => { navigatedTab = 'chat-app'; };
  globalThis.__overhaulTranslate = (key, params = {}) => {
    const parts = key.split('.');
    let value = zhLocale;
    for (const part of parts) value = value?.[part];
    if (typeof value !== 'string') return key;
    return value.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
  };
  globalThis.__overhaulInvoke = async (name, args) => {
    invokeCalls.push({ name, args });
    if (name === 'open_directory_dialog') return pickedFolder;
    if (name === 'hermes_status') return structuredClone(currentStatus);
    if (name === 'hermes_action') {
      if (args.action === 'sessionBinding') return structuredClone(handoffSnapshot);
      if (args.action === 'bindSession') {
        handoffSnapshot = {
          ...handoffSnapshot,
          binding: {
            id: 'bind-1',
            runtimeId: args.payload.runtimeId,
            routeId: args.payload.routeId,
            generation: args.payload.generation,
            title: 'Refactor Hermes',
            modelEnv: args.payload.modelEnv,
            model: 'deepseek-chat',
            lastDecision: null,
            error: null,
          },
          bindingValid: true,
          deliveryStatus: 'pending',
        };
        return structuredClone(handoffSnapshot);
      }
      if (args.action === 'updateRoute') {
        currentStatus = {
          ...currentStatus,
          routes: currentStatus.routes.map((route) => (
            route.id === args.payload.id
              ? {
                  ...route,
                  revision: (route.revision ?? 0) + 1,
                  workspaces: args.payload.workspaces,
                  allowInput: args.payload.allowInput,
                  notifications: args.payload.notifications,
                }
              : route
          )),
        };
      }
      if (args.action === 'removeRoute') {
        currentStatus = {
          ...currentStatus,
          routes: currentStatus.routes.filter((route) => route.id !== args.payload.id),
        };
      }
      if (args.action === 'retryDelivery') {
        currentStatus = {
          ...currentStatus,
          deliveries: currentStatus.deliveries.map((d) => (
            d.id === args.payload.id ? { ...d, status: 'pending', retryable: false } : d
          )),
        };
      }
      return structuredClone(currentStatus);
    }
    throw new Error(`Unhandled invoke: ${name}`);
  };
  mountPoint = document.createElement('main');
  document.body.append(mountPoint);
});

test.afterEach(async () => {
  if (root) await harness.act(async () => root.unmount());
  root = null;
  document.body.innerHTML = '';
});

test.after(async () => {
  dom.window.close();
  stopEsbuild();
  await fs.rm(temp, { recursive: true, force: true });
});

async function click(el) {
  assert.ok(el, 'expected target element to exist');
  await harness.act(async () => { el.click(); });
  await flush();
}

test('first-run onboarding card explains supported platforms and local runtime size', async () => {
  currentStatus = makeStatus({
    installer: { state: 'not_installed', version: null, downloadedBytes: 0, totalBytes: null, retryable: false },
  });
  root = harness.mountPanel(mountPoint);
  await flush();
  const onboarding = mountPoint.querySelector('[data-hermes-onboarding]');
  assert.ok(onboarding, 'renders onboarding card when runtime is not installed');
  assert.match(onboarding.textContent, /160 MB/);
  assert.match(onboarding.textContent, /飞书/);
  assert.match(onboarding.textContent, /企业微信/);
});

test('localized Feishu manual form renders domain selector and human-readable field labels', async () => {
  root = harness.mountPanel(mountPoint);
  await flush();
  await click(mountPoint.querySelector('[data-hermes-add]'));
  await click(mountPoint.querySelector('[data-hermes-platform="feishu"] button'));
  assert.match(mountPoint.textContent, /飞书应用 App ID/);
  assert.match(mountPoint.textContent, /飞书应用 App Secret/);
  assert.match(mountPoint.textContent, /服务站点/);
  const domainTrigger = document.getElementById('hermes-field-FEISHU_DOMAIN');
  assert.ok(domainTrigger);
  assert.equal(domainTrigger.tagName, 'BUTTON', 'FEISHU_DOMAIN uses a Select combobox instead of raw text input');
});

test('paired userName, local folder picker, revision-preserving route update, and disabled route removal work end-to-end', async () => {
  currentStatus = makeStatus({
    connections: [{
      accountRef: source.accountRef,
      platform: 'feishu',
      label: '研发助手',
      configuredFields: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
      enabled: true,
      conversationModel: { envName: 'deepseek', model: 'deepseek-chat' },
      toolsMode: 'ccem',
      nativeToolsAvailable: true,
      state: 'running',
      error: 'route_authority_changed',
      pending: [],
    }],
    routes: [
      {
        id: 'route-active',
        generation: 1,
        revision: 0,
        userName: '王志腾',
        source,
        workspaces: ['/projects/alpha'],
        enabled: true,
        allowInput: true,
        notifications: true,
      },
      {
        id: 'route-disabled',
        generation: 2,
        revision: 1,
        userName: '旧测试号',
        source: { ...source, userId: 'ou_old_user', chatId: 'oc_old_chat' },
        workspaces: [],
        enabled: false,
        allowInput: false,
        notifications: false,
      },
    ],
  });
  root = harness.mountPanel(mountPoint);
  await flush();

  // Card summary displays paired userName and conversation model envName
  const card = mountPoint.querySelector(`[data-hermes-connection="${source.accountRef}"]`);
  assert.match(card.textContent, /王志腾/);
  assert.match(card.textContent, /deepseek/);

  // Open connection details drawer
  await click(mountPoint.querySelector(`[data-hermes-open="${source.accountRef}"]`));
  const drawer = document.querySelector(`[data-hermes-connection-details="${source.accountRef}"]`);
  assert.ok(drawer);
  assert.match(drawer.textContent, /权限已在其他位置更新/, 'raw snake_case error is localized');
  assert.match(drawer.textContent, /王志腾/);

  // Edit active route workspace access using local folder picker while keeping generation=1
  const editAccessBtn = [...drawer.querySelectorAll('button')].find((b) => b.textContent.includes('设置工作区权限'));
  await click(editAccessBtn);
  await click(drawer.querySelector('[data-hermes-pick-folder]'));
  assert.ok(drawer.textContent.includes('CustomRepo'), 'picked folder is added to workspace list');

  const saveAccessBtn = [...drawer.querySelectorAll('button')].find((b) => b.textContent.includes('保存权限'));
  await click(saveAccessBtn);
  const updateCall = invokeCalls.find((c) => c.name === 'hermes_action' && c.args.action === 'updateRoute');
  assert.ok(updateCall);
  assert.equal(updateCall.args.payload.generation, 1);
  assert.equal(updateCall.args.payload.revision, 0);
  assert.deepEqual(updateCall.args.payload.workspaces, ['/projects/alpha', '/Users/wzt/CustomRepo']);
  assert.equal(drawer.querySelector('[data-hermes-route-editor]'), null, 'editor closes cleanly when revision increments');

  // Remove disabled zombie route
  await click(drawer.querySelector('[data-hermes-remove-route="route-disabled"]'));
  assert.ok(invokeCalls.some((c) => c.name === 'hermes_action' && c.args.action === 'removeRoute' && c.args.payload.id === 'route-disabled'));
  assert.equal(drawer.querySelector('[data-hermes-route="route-disabled"]'), null);
});

test('activity feed renders session title, bot label, message preview, and retryDelivery action', async () => {
  currentStatus = makeStatus({
    operations: [{
      id: 'hermes:op-1',
      runtimeId: 'rt-alpha',
      state: 'running',
      detail: 'Waiting for chat confirmation',
      updatedAt: Date.now(),
      botLabel: '研发助手',
      platform: 'feishu',
      sessionTitle: '重构网关鉴权',
    }],
    deliveries: [{
      id: 'deliv-failed-1',
      status: 'not_sent',
      createdAt: Date.now(),
      botLabel: '研发助手',
      platform: 'feishu',
      preview: 'CCEM · 重构网关鉴权：已完成代码修改',
      retryable: true,
    }],
  });
  root = harness.mountPanel(mountPoint);
  await flush();

  assert.match(mountPoint.textContent, /等待在聊天中回复确认/, 'legacy English operation detail is localized');
  assert.match(mountPoint.textContent, /研发助手 · 重构网关鉴权 · rt-alpha/);
  assert.match(mountPoint.textContent, /CCEM · 重构网关鉴权：已完成代码修改/);

  await click(mountPoint.querySelector('[data-hermes-retry-delivery="deliv-failed-1"]'));
  assert.ok(invokeCalls.some((c) => c.name === 'hermes_action' && c.args.action === 'retryDelivery' && c.args.payload.id === 'deliv-failed-1'));
});

test('workspace handoff pre-fills bot modelEnv for 1-click bind, offers setup navigation when empty, and refreshes badge on focus', async () => {
  root = harness.mountHandoff(mountPoint);
  await flush();

  // Even though defaultModelEnv is 'official' (incompatible), target.modelEnv ('deepseek') pre-fills!
  const startBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('开始接管'));
  assert.equal(startBtn.disabled, false, '1-click handoff enabled immediately via target bot modelEnv');
  await click(startBtn);
  const bindCall = invokeCalls.find((c) => c.name === 'hermes_action' && c.args.action === 'bindSession');
  assert.equal(bindCall.args.payload.modelEnv, 'deepseek');

  await harness.act(async () => root.unmount());
  root = null;

  // Empty targets offers direct navigation to ChatApp
  handoffSnapshot = { ...handoffSnapshot, binding: null, targets: [] };
  root = harness.mountHandoff(mountPoint);
  await flush();
  await click(document.querySelector('[data-hermes-go-setup]'));
  assert.equal(navigatedTab, 'chat-app');

  await harness.act(async () => root.unmount());
  root = null;

  // Session badge refreshes immediately on window focus
  handoffSnapshot = {
    ...handoffSnapshot,
    targets: [{
      routeId: 'route-1',
      generation: 1,
      accountRef: source.accountRef,
      platform: 'feishu',
      label: '研发助手',
      chatId: source.chatId,
      userId: source.userId,
      userName: '王志腾',
      chatType: 'dm',
      handoffReady: true,
      modelEnv: 'deepseek',
    }],
    binding: {
      id: 'bind-1',
      runtimeId: 'rt-1',
      routeId: 'route-1',
      generation: 1,
      title: 'Refactor Hermes',
      modelEnv: 'deepseek',
      model: 'deepseek-chat',
      lastDecision: null,
      error: null,
    },
    bindingValid: true,
    deliveryStatus: 'sent',
  };
  const beforeFocusCalls = invokeCalls.filter((c) => c.args?.action === 'sessionBinding').length;
  root = harness.mountBadge(mountPoint);
  await flush();
  assert.ok(mountPoint.querySelector('[data-hermes-session-badge]'));
  await harness.act(async () => { window.dispatchEvent(new Event('focus')); });
  await flush();
  const afterFocusCalls = invokeCalls.filter((c) => c.args?.action === 'sessionBinding').length;
  assert.ok(afterFocusCalls >= beforeFocusCalls + 2, 'focus event triggers immediate badge refresh');
});

test('workspace transcript marks remote Hermes user prompts with fromHermes provenance', () => {
  const messages = harness.buildMessagesFromEvents([], [], [
    {
      seq: 1,
      occurred_at: new Date().toISOString(),
      payload: {
        type: 'user_prompt',
        text: '请继续跑一下单元测试',
        image_count: 0,
        images: [],
        client_message_id: 'hermes:op-remote-1',
      },
    },
    {
      seq: 2,
      occurred_at: new Date().toISOString(),
      payload: {
        type: 'user_prompt',
        text: '本地补充说明',
        image_count: 0,
        images: [],
        client_message_id: 'local-uuid-2',
      },
    },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].fromHermes, true);
  assert.equal(messages[1].fromHermes, undefined);
});
