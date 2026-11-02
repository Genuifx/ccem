import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build, stop } from 'esbuild';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const desktop = path.resolve(import.meta.dirname, '..');
let directory;
let dom;
let harness;
let root;
let host;
let current;
let calls;
let handler;
let intervals;
const globals = new Map();
const candidate = (state = 'missing', overrides = {}) => ({ state, path: null, version: null, detail: null, ...overrides });
const selection = (source = 'system') => ({ source, path: source === 'system' ? '/usr/local/bin/claude' : '/ccem/runtime/claude', version: '2.1.220' });
const snapshot = (overrides = {}) => ({
  preference: 'auto', recommendedVersion: '2.1.220', minimumSystemVersion: '2.1.220',
  registryUrl: 'https://registry.npmjs.org/', registryError: null,
  system: candidate('available', selection()), managed: candidate(), selected: selection(),
  install: { state: 'idle', downloadedBytes: 0, totalBytes: null, error: null },
  supported: true, unsupportedReason: null, ...overrides,
});
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test.before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-claude-runtime-ui-'));
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const values = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MessageChannel: class { constructor() { this.port1 = { onmessage: null }; this.port2 = { postMessage: data => queueMicrotask(() => this.port1.onmessage?.({ data })) }; } },
  };
  for (const key of ['HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'KeyboardEvent', 'NodeFilter', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'Event', 'MouseEvent', 'CustomEvent']) values[key] = dom.window[key];
  for (const [key, value] of Object.entries(values)) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
  const outfile = path.join(directory, 'harness.cjs');
  const workspaceSource = await fs.readFile(path.join(desktop, 'src/pages/Workspace.tsx'), 'utf8');
  const ast = ts.createSourceFile('Workspace.tsx', workspaceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let forkCallback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'runForkFromTurn') forkCallback = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(forkCallback);
  await build({
    stdin: { contents: `import React, {act, useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {ClaudeRuntimeSettings, ClaudeRuntimeRequiredDialog} from '@/components/ClaudeRuntimeSettings';
      import {AgentProfilesSettings} from '@/components/AgentProfilesSettings';
      import {isClaudeRuntimeRequiredError} from '@/lib/claude-runtime';
      import {nativeCreateFailure} from '@/components/workspace/composerSubmissionResult';
      export {act, isClaudeRuntimeRequiredError};
      export function mount(host, dialog=false) { function Harness() { const [open,setOpen]=useState(true);
        return dialog === 'profile' ? <AgentProfilesSettings /> : dialog === 'two' ? <><ClaudeRuntimeSettings /><ClaudeRuntimeSettings /></> : dialog ? <ClaudeRuntimeRequiredDialog open={open} onOpenChange={setOpen} /> : <ClaudeRuntimeSettings />; }
        const root=createRoot(host); act(()=>root.render(<Harness />)); return root; }
      export function forkFailure(error) {
        const state = { calls: 0, prompts: [], errors: [], busy: [], setup: false, forkClosed: false };
        const forkDialog = { request: { envName:'test', permMode:'dev', workingDir:'/project', providerSessionId:'parent', forkFromMessageId:'turn', seedMessages:[] } };
        const isForkingTurn = false;
        const setIsForkingTurn = value => state.busy.push(value);
        const setClaudeRuntimeRequired = value => state.setup = value;
        const createNativeSession = async payload => { state.calls++; state.prompts.push(payload.initialPrompt); throw error; };
        const toast = {error: message => state.errors.push(message)};
        const t = key => key;
        const setForkDialog = () => state.forkClosed = true;
        const run = ${forkCallback};
        return run('preserve my fork draft').then(()=>state);
      }`, loader: 'tsx', resolveDir: desktop },
    outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
    plugins: [{ name: 'runtime-boundaries', setup(builder) {
      builder.onResolve({ filter: /^(@tauri-apps\/api\/core|@\/locales|@\/lib\/nativeSurfaceOcclusion|@\/lib\/nativeBrowserOverlay|sonner|@\/store|@\/features\/conversations\/historyData)$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents:
        path === 'sonner' ? 'export const toast={success:text=>globalThis.__runtimeToasts.push(text),error:text=>globalThis.__runtimeToasts.push(text)};'
          : path === '@/store' ? 'export const useAppStore={getState:()=>({setInstalledSkills(){}})};'
            : path === '@/features/conversations/historyData' ? 'export const invalidateHistoryCache=()=>{};'
        : path === '@/locales' ? 'export function useLocale(){return {t:(key,params={})=>key+Object.values(params).map(value=>" "+value).join("")};}'
          : path === '@/lib/nativeSurfaceOcclusion' ? 'export const useNativeSurfaceOcclusion = open => open;'
            : path === '@/lib/nativeBrowserOverlay' ? 'export const useNativeBrowserOverlayRef = ref => ref;'
              : 'export const invoke=(name,args)=>globalThis.__claudeRuntimeInvoke(name,args);',
      }));
    } }],
  });
  harness = require(outfile);
});

test.beforeEach(() => {
  current = snapshot(); calls = []; intervals = [];
  globalThis.__runtimeToasts = [];
  handler = async (name, args) => {
    if (name === 'set_claude_runtime_source') {
      current.preference = args.source;
      current.selected = args.source === 'managed' ? null : selection();
    }
    if (name === 'set_claude_runtime_registry') {
      current.registryUrl = args.registryUrl.replace(/\/?$/, '/');
      current.registryError = null;
    }
    return structuredClone(current);
  };
  globalThis.__claudeRuntimeInvoke = async (name, args) => { calls.push({ name, args }); return handler(name, args); };
  dom.window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  dom.window.clearInterval = id => { intervals[id - 1] = null; };
  host = document.createElement('main'); document.body.append(host);
});
test.afterEach(async () => {
  if (root) await harness.act(async () => root.unmount());
  root = null; document.body.innerHTML = '';
});
test.after(async () => {
  delete globalThis.__claudeRuntimeInvoke;
  delete globalThis.__runtimeToasts;
  dom.window.close(); stop(); await fs.rm(directory, { recursive: true, force: true });
  for (const [key, original] of globals) {
    if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key];
  }
});

async function settle() { await harness.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function mount(dialog = false) { root = harness.mount(host, dialog); await settle(); }
async function click(selector) {
  const button = document.querySelector(selector); assert.ok(button, selector);
  harness.act(() => { button.click(); });
  await settle();
}
async function poll() { harness.act(() => { for (const callback of [...intervals]) callback?.(); }); await settle(); }
const commands = name => calls.filter(call => call.name === name);

async function chooseRegistry(choice, panel = 0) {
  const trigger = document.querySelectorAll('[data-claude-runtime-registry-select]')[panel];
  harness.act(() => {
    trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await settle();
  const option = document.querySelector(`[data-claude-runtime-registry-option="${choice}"]`);
  assert.ok(option, `registry option ${choice}`);
  harness.act(() => { option.focus(); option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await settle();
}

async function editRegistry(value) {
  const input = document.querySelector('[data-claude-runtime-registry-input]');
  assert.ok(input);
  harness.act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

test('opening settings only detects; choices persist without downloading or changing profiles', async () => {
  await mount();
  assert.match(host.textContent, /\/usr\/local\/bin\/claude/);
  assert.match(host.textContent, /2\.1\.220/);
  assert.equal(document.querySelector('[data-claude-runtime-source="auto"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(calls, [{ name: 'get_claude_runtime_status', args: { refresh: false } }]);
  await click('[data-claude-runtime-source="managed"]');
  assert.equal(document.querySelector('[data-claude-runtime-source="managed"]').getAttribute('aria-pressed'), 'true');
  assert.equal(commands('install_claude_runtime').length, 0);
  assert.equal(commands('set_codex_isolation').length, 0);
  await harness.act(async () => root.unmount()); root = null;
  await mount();
  assert.equal(document.querySelector('[data-claude-runtime-source="managed"]').getAttribute('aria-pressed'), 'true');
  await click('[data-claude-runtime-refresh]');
  assert.deepEqual(calls.at(-1), { name: 'get_claude_runtime_status', args: { refresh: true } });
});

test('failed source change keeps the saved selection and displays its error', async () => {
  handler = async name => { if (name === 'set_claude_runtime_source') throw new Error('Cannot save runtime preference'); return structuredClone(current); };
  await mount(); await click('[data-claude-runtime-source="managed"]');
  assert.equal(document.querySelector('[data-claude-runtime-source="auto"]').getAttribute('aria-pressed'), 'true');
  assert.match(host.querySelector('[role="alert"]').textContent, /Cannot save runtime preference/);
  assert.equal(commands('install_claude_runtime').length, 0);
});

test('registry presets save independently, sync other panels, and persist through detection and remount', async () => {
  await mount('two');
  await chooseRegistry('mirror');
  assert.deepEqual(commands('set_claude_runtime_registry'), [{ name: 'set_claude_runtime_registry', args: { registryUrl: 'https://registry.npmmirror.com/' } }]);
  for (const select of document.querySelectorAll('[data-claude-runtime-registry-select]')) assert.match(select.textContent, /registryMirror/);
  assert.equal(current.preference, 'auto');
  assert.equal(current.selected.source, 'system');
  assert.equal(commands('set_claude_runtime_source').length, 0);
  assert.equal(commands('install_claude_runtime').length, 0);
  await click('[data-claude-runtime-refresh]');
  assert.match(document.querySelector('[data-claude-runtime-registry-select]').textContent, /registryMirror/);
  await harness.act(async () => root.unmount()); root = null;
  await mount();
  assert.match(document.querySelector('[data-claude-runtime-registry-select]').textContent, /registryMirror/);
});

test('custom registry is saved explicitly, retains failed input, and download retry uses the saved source', async () => {
  let failSave = true;
  const downloadedFrom = [];
  handler = async (name, args) => {
    if (name === 'set_claude_runtime_registry') {
      if (failSave) throw new Error('Registry must use HTTPS without credentials, query, or fragment');
      current.registryUrl = args.registryUrl.replace(/\/?$/, '/');
    }
    if (name === 'install_claude_runtime') {
      downloadedFrom.push(current.registryUrl);
      current.install.state = 'downloading';
    }
    if (name === 'cancel_claude_runtime_install') current.install.state = 'cancelled';
    return structuredClone(current);
  };
  await mount(true); await chooseRegistry('custom');
  await editRegistry('http://registry.example.com/npm');
  assert.equal(commands('set_claude_runtime_registry').length, 0);
  assert.equal(document.querySelector('[data-claude-runtime-download]').disabled, true);
  await click('[data-claude-runtime-registry-save]');
  assert.match(document.body.textContent, /Registry must use HTTPS/);
  assert.equal(document.querySelector('[data-claude-runtime-registry-input]').value, 'http://registry.example.com/npm');
  assert.equal(current.registryUrl, 'https://registry.npmjs.org/');
  failSave = false;
  await editRegistry('https://registry.example.com/npm');
  await click('[data-claude-runtime-registry-save]');
  assert.equal(document.querySelector('[data-claude-runtime-registry-input]').value, 'https://registry.example.com/npm/');
  assert.equal(document.querySelector('[data-claude-runtime-download]').disabled, false);
  await click('[data-claude-runtime-download]');
  await click('[data-claude-runtime-cancel]');
  await click('[data-claude-runtime-download]');
  assert.deepEqual(downloadedFrom, ['https://registry.example.com/npm/', 'https://registry.example.com/npm/']);
  assert.equal(commands('create_native_session').length, 0);
});

test('registry saving and active installation disable registry controls', async () => {
  const save = deferred();
  handler = async (name, args) => {
    if (name === 'set_claude_runtime_registry') { current.registryUrl = args.registryUrl; return save.promise; }
    if (name === 'install_claude_runtime') current.install.state = 'downloading';
    return structuredClone(current);
  };
  await mount(); await chooseRegistry('custom'); await editRegistry('https://registry.example.com/');
  await click('[data-claude-runtime-registry-save]');
  for (const attribute of ['select', 'input', 'save']) assert.equal(document.querySelector(`[data-claude-runtime-registry-${attribute}]`).disabled, true);
  assert.match(host.textContent, /registrySaving/);
  await harness.act(async () => save.resolve(structuredClone(current)));
  await click('[data-claude-runtime-download]');
  for (const attribute of ['select', 'input', 'save']) assert.equal(document.querySelector(`[data-claude-runtime-registry-${attribute}]`).disabled, true);
});

test('stale detection cannot overwrite a newly saved registry', async () => {
  const stale = deferred();
  await mount();
  let firstRead = true;
  handler = async (name, args) => {
    if (name === 'get_claude_runtime_status' && firstRead) { firstRead = false; return stale.promise; }
    if (name === 'set_claude_runtime_registry') current.registryUrl = args.registryUrl;
    return structuredClone(current);
  };
  harness.act(() => window.dispatchEvent(new Event('ccem-claude-runtime-changed')));
  await chooseRegistry('mirror');
  await harness.act(async () => stale.resolve(snapshot()));
  assert.match(document.querySelector('[data-claude-runtime-registry-select]').textContent, /registryMirror/);
});

test('a panel with a pending action catches up with registry changes saved from another panel', async () => {
  const source = deferred();
  let staleStatus;
  handler = async (name, args) => {
    if (name === 'set_claude_runtime_source') {
      current.preference = args.source; staleStatus = structuredClone(current); return source.promise;
    }
    if (name === 'set_claude_runtime_registry') current.registryUrl = args.registryUrl;
    return structuredClone(current);
  };
  await mount('two');
  await click('[data-claude-runtime-source="system"]');
  await chooseRegistry('mirror', 1);
  await harness.act(async () => source.resolve(staleStatus));
  await settle();
  for (const select of document.querySelectorAll('[data-claude-runtime-registry-select]')) assert.match(select.textContent, /registryMirror/);
});

test('invalid saved registry blocks downloads until explicitly corrected, without blocking installed runtime selection', async () => {
  current.registryError = 'Invalid saved registry URL';
  await mount();
  assert.match(host.textContent, /Invalid saved registry URL/);
  assert.match(host.textContent, /\/usr\/local\/bin\/claude/);
  assert.equal(document.querySelector('[data-claude-runtime-download]').disabled, true);
  await chooseRegistry('official');
  assert.deepEqual(commands('set_claude_runtime_registry'), [{ name: 'set_claude_runtime_registry', args: { registryUrl: 'https://registry.npmjs.org/' } }]);
  assert.equal(document.querySelector('[data-claude-runtime-download]').disabled, false);
  assert.equal(commands('install_claude_runtime').length, 0);
});

test('explicit download reports progress, cancels, retries, and becomes ready without sending a prompt', async () => {
  current = snapshot({ system: candidate(), selected: null });
  handler = async name => {
    if (name === 'install_claude_runtime') current.install = { state: 'downloading', downloadedBytes: 50, totalBytes: 100, error: null };
    if (name === 'cancel_claude_runtime_install') current.install.state = 'cancelled';
    return structuredClone(current);
  };
  await mount(true);
  assert.equal(commands('install_claude_runtime').length, 0);
  await click('[data-claude-runtime-download]');
  assert.equal(commands('install_claude_runtime').length, 1);
  assert.equal(document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '50');
  await click('[data-claude-runtime-cancel]');
  assert.equal(commands('cancel_claude_runtime_install').length, 1);
  assert.match(document.querySelector('[data-claude-runtime-download]').textContent, /retryDownload/);
  await click('[data-claude-runtime-download]');
  current.install.state = 'installed'; current.managed = candidate('available', selection('managed')); current.selected = selection('managed');
  await poll();
  assert.match(document.body.textContent, /\/ccem\/runtime\/claude/);
  assert.equal(document.querySelector('[data-claude-runtime-progress]'), null);
  assert.equal(commands('create_native_session').length, 0);
  assert.equal(commands('send_native_session_input').length, 0);
  assert.ok(document.querySelector('[data-claude-runtime-required]'), 'successful install leaves the saved draft under user control');
});

test('forced system download-and-use explicitly selects managed before installing', async () => {
  current = snapshot({ preference: 'system', system: candidate('incompatible', { version: '2.0.0' }), selected: null });
  await mount(true);
  assert.match(document.querySelector('[data-claude-runtime-download]').textContent, /downloadAndUse/);
  await click('[data-claude-runtime-download]');
  const mutations = calls.filter(call => call.name !== 'get_claude_runtime_status');
  assert.deepEqual(mutations, [
    { name: 'set_claude_runtime_source', args: { source: 'managed' } },
    { name: 'install_claude_runtime', args: undefined },
  ]);
});

test('download errors retain selection and offer explicit retry; unsupported platforms cannot download', async () => {
  current = snapshot({ preference: 'managed', selected: null,
    install: { state: 'error', downloadedBytes: 0, totalBytes: null, error: 'Download checksum did not match' } });
  await mount();
  assert.match(host.querySelector('[role="alert"]').textContent, /checksum did not match/);
  assert.match(host.querySelector('[data-claude-runtime-download]').textContent, /retryDownload/);
  assert.equal(commands('install_claude_runtime').length, 0);
  current.supported = false; current.unsupportedReason = 'Unsupported platform';
  await click('[data-claude-runtime-refresh]');
  assert.equal(host.querySelector('[data-claude-runtime-download]'), null);
  assert.match(host.textContent, /Unsupported platform/);
});

test('stale detection cannot overwrite a later saved source selection', async () => {
  const stale = deferred();
  await mount();
  let firstRead = true;
  handler = async (name, args) => {
    if (name === 'get_claude_runtime_status' && firstRead) { firstRead = false; return stale.promise; }
    if (name === 'set_claude_runtime_source') current.preference = args.source;
    return structuredClone(current);
  };
  // A background refresh may overlap a mutation from a second surface.
  await harness.act(async () => window.dispatchEvent(new Event('ccem-claude-runtime-changed')));
  await click('[data-claude-runtime-source="system"]');
  assert.equal(document.querySelector('[data-claude-runtime-source="system"]').getAttribute('aria-pressed'), 'true');
  await harness.act(async () => { stale.resolve(snapshot()); });
  assert.equal(document.querySelector('[data-claude-runtime-source="system"]').getAttribute('aria-pressed'), 'true');
});

test('setup classification excludes auth, network, Codex, and uncertain transport errors', () => {
  assert.equal(harness.isClaudeRuntimeRequiredError('NATIVE_CREATE_REJECTED: CLAUDE_RUNTIME_REQUIRED: {"reason":"missing"}'), true);
  for (const error of [
    'CLAUDE_RUNTIME_REQUIRED: {"reason":"missing"}',
    'NATIVE_CREATE_REJECTED: Invalid API key',
    'Network request timed out',
    'NATIVE_CREATE_REJECTED: CODEX_RUNTIME_REQUIRED: missing',
    new Error('transport disconnected after dispatch'),
  ]) assert.equal(harness.isClaudeRuntimeRequiredError(error), false);
});

test('profile login opens runtime setup only for the explicit resolver error, without downloading or logging in again', async () => {
  current = snapshot({ system: candidate(), selected: null });
  handler = async name => {
    if (name === 'get_agent_profiles') return [{ provider: 'claude', isolated: true, initialized: true, directory: '/profiles/claude' }];
    if (name === 'login_agent_profile') throw 'CLAUDE_RUNTIME_REQUIRED: {"reason":"missing"}';
    return structuredClone(current);
  };
  await mount('profile');
  await click('[data-testid="agent-profile-claude"] button');
  assert.ok(document.querySelector('[data-claude-runtime-required]'));
  assert.match(document.querySelector('[data-claude-runtime-required]').textContent, /requiredLoginDescription/);
  assert.equal(commands('install_claude_runtime').length, 0);
  assert.equal(commands('login_agent_profile').length, 1);
  assert.equal(commands('set_claude_runtime_registry').length, 0);
  assert.deepEqual(globalThis.__runtimeToasts, []);
});

test('profile login auth failures do not trigger installation setup', async () => {
  handler = async name => {
    if (name === 'get_agent_profiles') return [{ provider: 'claude', isolated: true, initialized: true, directory: '/profiles/claude' }];
    if (name === 'login_agent_profile') throw 'Authentication failed';
    return structuredClone(current);
  };
  await mount('profile'); await click('[data-testid="agent-profile-claude"] button');
  assert.equal(document.querySelector('[data-claude-runtime-required]'), null);
  assert.deepEqual(globalThis.__runtimeToasts, ['Authentication failed']);
  assert.equal(commands('install_claude_runtime').length, 0);
  assert.equal(commands('set_claude_runtime_registry').length, 0);
});

test('actual fork callback preserves its dialog and draft while opening setup only for certified startup rejection', async () => {
  const rejected = await harness.forkFailure('NATIVE_CREATE_REJECTED: CLAUDE_RUNTIME_REQUIRED: {"reason":"missing"}');
  assert.deepEqual(rejected, { calls: 1, prompts: ['preserve my fork draft'], errors: [], busy: [true, false], setup: true, forkClosed: false });
  for (const error of ['CLAUDE_RUNTIME_REQUIRED: uncertain', 'Authentication failed', 'Network request timed out']) {
    const failed = await harness.forkFailure(error);
    assert.equal(failed.setup, false);
    assert.deepEqual(failed.errors, [error]);
    assert.equal(failed.calls, 1);
    assert.equal(failed.forkClosed, false);
  }
});
