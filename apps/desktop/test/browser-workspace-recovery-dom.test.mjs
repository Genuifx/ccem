import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const sourceDir = path.resolve(import.meta.dirname, '../src');
const sourceCache = new Map();
const clone = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function host() {
  let currentDocument, generation = -1, workspace = null;
  const calls = [];
  const surfaces = new Map();
  return {
    calls, surfaces,
    get workspace() { return workspace; },
    async invoke(command, args) {
      calls.push({ command, args: clone(args) });
      if (command === 'webcontent_frontend_boot') {
        currentDocument = args.documentId;
        generation++;
        return { documentId: currentDocument, generation, recovered: generation > 0, browserWorkspace: clone(workspace) };
      }
      if (command === 'webcontent_browser_workspace_save') {
        assert.equal(args.documentId, currentDocument);
        assert.equal(args.generation, generation);
        workspace = clone(args.workspace);
      } else {
        assert.equal(args.frontendDocumentId, currentDocument);
        assert.equal(args.frontendGeneration, generation);
        if (command === 'browser_surface_acquire') {
          assert.ok(Object.values(workspace.targets).some(target => target.surfaceSessionId === args.panelSessionId));
          if (!surfaces.has(args.panelSessionId)) surfaces.set(args.panelSessionId, { id: `cef-${surfaces.size + 1}`, value: '' });
          return surfaces.get(args.panelSessionId);
        }
      }
    },
  };
}

async function documentModules(id, bridge) {
  const timers = new Map();
  const modules = new Map();
  const files = {
    '@/lib/webcontentRecovery': 'lib/webcontentRecovery.ts',
    './browserPanelTarget': 'components/workspace/browserPanelTarget.ts',
    './hook': 'components/workspace/useBrowserWorkspaceRecovery.ts',
  };
  for (const file of Object.values(files)) {
    if (!sourceCache.has(file)) sourceCache.set(file, ts.transpileModule(
      await fs.readFile(path.join(sourceDir, file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      },
    ).outputText);
  }
  function load(name) {
    if (name === 'react') return React;
    if (name === '@tauri-apps/api/core') return { invoke: bridge };
    if (name === './recoveryDrafts') return { recoveryDraftDiagnostics: () => ({}) };
    if (modules.has(name)) return modules.get(name);
    assert.ok(name in files, name);
    const module = {};
    modules.set(name, module);
    new Function('require', 'exports', 'window', 'crypto', 'setTimeout', 'clearTimeout', 'console', sourceCache.get(files[name]))(
      load, module, { __TAURI_INTERNALS__: {} }, { randomUUID: () => id },
      fn => { timers.set(1, fn); return 1; }, key => timers.delete(key), { warn() {} },
    );
    return module;
  }
  const recovery = load('@/lib/webcontentRecovery');
  return { recovery, target: load('./browserPanelTarget'), hook: load('./hook'), timeout: () => [...timers.values()].forEach(fn => fn()) };
}

async function mount(t, modules) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  let state;
  const root = createRoot(document.getElementById('root'));
  function Harness() {
    state = modules.hook.useBrowserWorkspaceRecovery();
    return React.createElement('button', {
      disabled: !state.ready,
      onClick() {
        const owner = state.sessionKeyRegistryRef.current.resolveLive({ provider: 'claude', runtimeId: 'runtime-a' });
        state.updateTargets(previous => modules.target.toggleDefaultBrowserPanelTarget(
          previous, owner, '/fixture', () => ++state.instanceSequenceRef.current,
        ));
      },
    }, JSON.stringify(state.targets));
  }
  await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))));
  let closed = false;
  const unmount = () => {
    if (closed) return;
    closed = true;
    React.act(() => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  t.after(unmount);
  return { get state() { return state; }, get button() { return dom.window.document.querySelector('button'); }, unmount };
}

test('a full renderer reload restores aliases, hidden targets, sequence and the same retained page before acquisition', async t => {
  const native = host();
  const first = await documentModules('document-a', native.invoke);
  await first.recovery.initializeWebcontentRecovery();
  const before = await mount(t, first);
  await React.act(async () => before.button.click());
  const owner = 'runtime:runtime-a';
  const original = before.state.targets[owner];
  const page = await first.recovery.invokeBrowserCommand('browser_surface_acquire', { panelSessionId: original.surfaceSessionId });
  page.value = 'unsaved DOM input and Agent state';
  const alias = before.state.sessionKeyRegistryRef.current.resolveLive({ provider: 'claude', runtimeId: 'runtime-a', providerSessionId: 'provider-a' });
  assert.equal(alias, owner);
  await React.act(async () => before.button.click());
  await first.recovery.flushBrowserWorkspace();
  before.unmount();

  const second = await documentModules('document-b', native.invoke);
  await second.recovery.initializeWebcontentRecovery();
  const after = await mount(t, second);
  assert.equal(after.state.ready, true);
  assert.deepEqual(after.state.targets[owner], { ...original, visible: false });
  assert.equal(after.state.sessionKeyRegistryRef.current.resolveHistory({ provider: 'claude', providerSessionId: 'provider-a' }), owner);
  assert.equal(after.state.instanceSequenceRef.current, original.instanceId);
  await React.act(async () => after.button.click());
  const reconnected = await second.recovery.invokeBrowserCommand('browser_surface_acquire', { panelSessionId: original.surfaceSessionId });
  assert.equal(reconnected, page);
  assert.equal(reconnected.value, 'unsaved DOM input and Agent state');
  assert.equal(native.surfaces.size, 1);
  await React.act(async () => after.state.updateTargets(() => ({})));
  await React.act(async () => after.button.click());
  assert.notEqual(after.state.targets[owner].surfaceSessionId, original.surfaceSessionId, 'explicit close/reopen allocates a fresh identity');
  assert.equal(after.state.instanceSequenceRef.current, original.instanceId + 1);
});

test('late boot after startup timeout cannot save empty state or allocate a replacement browser', async t => {
  const native = host();
  const pending = deferred();
  const modules = await documentModules('late-document', (command, args) => command === 'webcontent_frontend_boot' ? pending.promise : native.invoke(command, args));
  const boot = modules.recovery.initializeWebcontentRecovery();
  modules.timeout();
  await boot;
  const mounted = await mount(t, modules);
  assert.equal(mounted.button.disabled, true);
  assert.equal(native.calls.length, 0);
  const workspace = { version: 1, instanceSequence: 4, targets: {
    'runtime:runtime-a': { backend: 'login', instanceId: 4, surfaceSessionId: 'draft:workspace:4', workingDir: '/fixture', profileMode: 'default', visible: true },
  }, sessionKeys: { runtime: [['runtime-a', 'runtime:runtime-a']], provider: [] } };
  await native.invoke('webcontent_frontend_boot', { documentId: 'late-document' });
  await React.act(async () => pending.resolve({ documentId: 'late-document', generation: 0, recovered: false, browserWorkspace: workspace }));
  assert.equal(mounted.button.disabled, false);
  assert.deepEqual(mounted.state.targets, workspace.targets);
  await modules.recovery.flushBrowserWorkspace();
  assert.deepEqual(native.workspace.targets, workspace.targets);
  assert.equal(native.calls.filter(call => call.command === 'webcontent_browser_workspace_save').length, 1);
});

test('acquisition waits for the latest metadata ACK, forwards generation zero, and can retry a failed save', async () => {
  const calls = [];
  const gate = deferred();
  let fail = true;
  const modules = await documentModules('fresh-document', async (command, args) => {
    calls.push({ command, args });
    if (command === 'webcontent_frontend_boot') return { documentId: args.documentId, generation: 0, recovered: false };
    if (command === 'webcontent_browser_workspace_save' && fail) return gate.promise;
    return 'acquired';
  });
  await modules.recovery.initializeWebcontentRecovery();
  const workspace = { version: 1, instanceSequence: 1, targets: {}, sessionKeys: { runtime: [], provider: [] } };
  void modules.recovery.saveBrowserWorkspace(workspace);
  const acquire = modules.recovery.invokeBrowserCommand('browser_surface_acquire', { panelSessionId: 'surface-a' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.some(call => call.command === 'browser_surface_acquire'), false);
  gate.reject(new Error('save failed'));
  const rejected = assert.rejects(acquire, /save failed/);
  for (let attempt = 0; attempt < 2; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
    modules.timeout();
  }
  await rejected;
  fail = false;
  assert.equal(await modules.recovery.invokeBrowserCommand('browser_surface_acquire', { panelSessionId: 'surface-a' }), 'acquired');
  assert.deepEqual(calls.filter(call => call.command === 'webcontent_browser_workspace_save').map(call => call.args.revision), [1, 1, 1, 2]);
  assert.deepEqual(calls.at(-1).args, { panelSessionId: 'surface-a', frontendDocumentId: 'fresh-document', frontendGeneration: 0 });
});
