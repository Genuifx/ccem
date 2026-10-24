import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build, stop } from 'esbuild';
import { JSDOM } from 'jsdom';

const desktop = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await delay(20);
  }
  assert.ok(check(), label);
}

// Production React, the real App/layout, native session view, poller and IPC
// hook. Page contents and App startup services are isolated. In particular,
// act() must not flush the deferred work whose starvation this test exercises.
test('navigation commits while a native transcript streams, including a delayed Scheduler', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-streaming-navigation-'));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map();
  const expose = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement',
    'HTMLTextAreaElement', 'DocumentFragment', 'Range', 'Text', 'ShadowRoot', 'NodeFilter', 'Event',
    'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'SVGElement']) {
    expose(key, dom.window[key]);
  }
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    expose(key, dom.window[key].bind(dom.window));
  }
  expose('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.ResizeObserver = globalThis.ResizeObserver;
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  expose('matchMedia', window.matchMedia);
  HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
  HTMLElement.prototype.scrollIntoView = function () {};
  window.__TAURI_INTERNALS__ = {
    invoke: async () => [], transformCallback: () => 0, unregisterCallback() {},
    metadata: { currentWindow: { label: 'fixture' }, currentWebview: { label: 'fixture' } },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };

  const runtimeId = 'navigation-stream-fixture';
  const summary = { runtime_id: runtimeId, provider: 'claude', transport: 'native',
    provider_session_id: runtimeId, env_name: 'fixture', project_dir: '/navigation-fixture',
    perm_mode: 'yolo', runtime_perm_mode: 'bypassPermissions', model: 'fixture', effort: 'high',
    status: 'processing', is_active: true, background_tasks: [] };
  const events = [];
  const append = (payload) => events.push({ runtime_id: runtimeId, seq: events.length + 1,
    occurred_at: '2026-10-24T00:00:00Z', payload });
  // A non-empty retained transcript, followed by an unfinished streaming turn.
  for (let i = 0; i < 30; i++) {
    append({ type: 'user_prompt', text: `问题 ${i}`, image_count: 0 });
    append({ type: 'assistant_chunk', text: `答复 ${i}` });
    append({ type: 'lifecycle', stage: 'turn_completed', detail: '' });
  }
  append({ type: 'lifecycle', stage: 'turn_started', detail: '' });
  let reads = 0;
  const sessionWrites = [];
  expose('__navigationInvoke', async (command, args = {}) => {
    if (command === 'stop_native_session' || command === 'send_native_session_input') sessionWrites.push(command);
    if (command === 'get_native_session_events' || command === 'get_native_session_event_page') {
      reads++;
      const end = args.snapshotNewestSeq ?? events.length;
      return { events: events.filter((event) => event.seq > (args.afterSeq ?? 0) && event.seq <= end),
        source_available: true, gap_detected: false, decode_failure_count: 0, oversized_event_count: 0,
        oldest_available_seq: 1, newest_available_seq: end, snapshot_newest_seq: end,
        next_cursor: end, has_more: false, truncated: false };
    }
    if (command === 'get_native_session_summary') return { ...summary, last_event_seq: events.length };
    if (command === 'get_workspace_git_snapshot') return { is_repo: false, files: [], dirty_count: 0 };
    if (command === 'get_settings') return {};
    return [];
  });
  expose('__navigationSession', summary);
  let held = false;
  const queued = [];
  const immediate = globalThis.setImmediate;
  expose('__navigationSchedule', (callback) => held ? queued.push(callback) : immediate(callback));
  let importsResolved = 0;
  expose('__navigationImportResolved', () => { importsResolved++; });
  let unmount;
  let publisher;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  t.after(async () => {
    clearInterval(publisher);
    held = false;
    for (const callback of queued.splice(0)) immediate(callback);
    unmount?.();
    await delay(50);
    console.error = originalError;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const pages = { Settings: 'settings', Analytics: 'analytics', Environments: 'environments', Skills: 'skills',
    History: 'history', Sessions: 'sessions', CronTasks: 'cron', ProxyDebug: 'proxy-debug', ChatApp: 'chat-app' };
  const stubs = {
    '@tauri-apps/api/core': `export * from ${JSON.stringify(path.join(desktop, 'node_modules/@tauri-apps/api/core.js'))};
      export const invoke = (...args) => globalThis.__navigationInvoke(...args);`,
    '@tauri-apps/api/event': 'export async function listen() { return () => {}; }',
    '@/hooks/useStartup': "export const useStartup = () => ({ ready: true, phase: 'ready' });",
    '@/hooks/useZoom': 'export const useZoom = () => {}; export const readAppZoom = () => 1;',
    '@/hooks/useWebcontentLifecycle': 'export const useWebcontentLifecycle = () => {};',
    '@/lib/idle': 'export const scheduleAfterFirstPaint = () => () => {};',
    '@/components/NativeBackgroundTaskAppGuard': `export const NativeBackgroundTaskAppGuardProvider = ({ children }) => children;
      export const useNativeBackgroundTaskAppGuard = () => ({ requestQuit() {} });`,
    '@/components/app-update/AppUpdateProvider': 'export const AppUpdateProvider = ({ children }) => children;',
    '@/components/layout/StartupSplash': 'export const StartupSplash = () => null;',
    '@/components/DeleteEnvConfirmDialog': 'export const DeleteEnvConfirmDialog = () => null;',
    '@/components/EnvironmentDialog': 'export const EnvironmentDialog = () => null;',
    '@/pages/Workspace': `import { useState } from 'react';
      import { WorkspaceNativeSessionView } from '@/components/workspace/WorkspaceNativeSessionView';
      const empty = []; const noop = () => {};
      export function Workspace({ isActive }) {
        const [session, setSession] = useState(globalThis.__navigationSession);
        return <section data-page="workspace" data-active={isActive}>
          <WorkspaceNativeSessionView session={session} isVisible={isActive} seedMessages={empty}
            installedSkills={empty} workspaceCommands={empty} initialPrompt={null} initialImages={null}
            initialAnnotations={null} onSessionUpdate={setSession} onStartNew={noop} />
        </section>;
      }`,
  };
  for (const [name, tab] of Object.entries(pages)) {
    stubs[`@/pages/${name}`] = `export const ${name} = () => <section data-page="${tab}">${tab} content</section>;
      export const prime${name}Page = () => {};`;
  }
  const output = path.join(dir, 'fixture.cjs');
  await build({
    stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom'; import App from './src/App';
      export function mount(element) { const root = createRoot(element);
        flushSync(() => root.render(<App />)); return () => flushSync(() => root.unmount()); }`,
      loader: 'tsx', sourcefile: 'fixture.tsx', resolveDir: desktop },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node20',
    logLevel: 'silent', alias: { '@': path.join(desktop, 'src') }, loader: { '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    plugins: [{ name: 'navigation-fixture', setup(builder) {
      builder.onLoad({ filter: /scheduler\.production\.min\.js$/ }, async ({ path: file }) => ({
        loader: 'js', resolveDir: path.dirname(file),
        contents: 'var setImmediate = globalThis.__navigationSchedule;\n' + await fs.readFile(file, 'utf8'),
      }));
      builder.onLoad({ filter: /[/\\]src[/\\]App\.tsx$/ }, async ({ path: file }) => ({
        loader: 'tsx', resolveDir: path.dirname(file),
        contents: (await fs.readFile(file, 'utf8')).replace(/import\((['"])@\/pages\/[^'"]+\1\)/g,
          (load) => `${load}.then(module => { globalThis.__navigationImportResolved(); return module; })`),
      }));
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === '@/hooks/useTauriCommands' && args.importer.endsWith('/App.tsx')) {
          return { path: 'startup-commands', namespace: 'navigation-stub' };
        }
        if (stubs[args.path]) return { path: args.path, namespace: 'navigation-stub' };
        if (/MacFullscreenWindowControls$|GlobalUpdateIndicator$/.test(args.path)) {
          return { path: 'native-controls', namespace: 'navigation-stub' };
        }
      });
      builder.onLoad({ filter: /.*/, namespace: 'navigation-stub' }, ({ path: name }) => ({
        loader: 'tsx', resolveDir: desktop, contents: stubs[name] ?? (name === 'startup-commands'
          ? 'const noop = async () => {}; const commands = new Proxy({}, { get: () => noop }); export const useTauriCommands = () => commands;'
          : 'export const MacFullscreenWindowControls = () => null; export const GlobalUpdateIndicator = () => null;'),
      }));
    } }],
  });
  localStorage.setItem('ccem-sidebar-state', 'expanded');
  unmount = require(output).mount(document.getElementById('root'));
  const query = (selector) => document.querySelector(selector);
  const text = () => document.getElementById('root').textContent;
  const click = async (selector) => {
    assert.ok(query(selector), selector);
    query(selector).click();
    await delay(20); // Only a native event/microtask turn, never act()/flushSync().
  };
  await waitFor(() => text().includes('答复 29'), 'retained native transcript renders');
  let chunks = 0;
  publisher = setInterval(() => append({ type: 'assistant_chunk', text: ` 流式${++chunks} ` }), 20);
  await waitFor(() => text().includes('流式'), 'real native poller commits live output');
  const editor = query('[contenteditable="true"]');
  assert.ok(editor, 'real native composer is mounted');
  await click('[data-testid="workspace-navigation-trigger"]');
  await waitFor(() => query('[data-testid="nav-settings"]'), 'application menu opens');

  // All module promises are allowed to resolve. Only deferred Scheduler work
  // is held, matching a different failure boundary from a hung code request.
  held = true;
  await click('[data-testid="nav-settings"]');
  await delay(250);
  assert.ok(query('[data-page="settings"]'),
    `settings must commit despite delayed work (resolved imports=${importsResolved}, queued callbacks=${queued.length})`);
  assert.doesNotMatch(text(), /Loading\.\.\./);
  assert.ok(chunks > 1, 'stream source remains active while navigation commits');
  held = false;
  for (const callback of queued.splice(0)) immediate(callback);

  // Normal scheduling: exercise every page while the source keeps producing,
  // then prove hidden polling pauses and catches up on return, without remount.
  for (const tab of Object.values(pages)) {
    // Global navigation lives behind the same top-left menu on every page.
    await click('[data-testid="workspace-navigation-trigger"]');
    await waitFor(() => query(`[data-testid="nav-${tab}"]`), 'application menu opens');
    await click(`[data-testid="nav-${tab}"]`);
    await waitFor(() => query(`[data-page="${tab}"]`), `${tab} content appears`);
    assert.doesNotMatch(text(), /Loading\.\.\./);
  }
  await delay(200);
  const hiddenReads = reads;
  await delay(350);
  assert.equal(reads, hiddenReads, 'hidden native session does not keep polling');
  for (let round = 0; round < 3; round++) {
    const before = chunks;
    await click('[data-testid="workspace-navigation-trigger"]');
    await waitFor(() => query('[data-testid="nav-workspace"]'), 'application menu opens');
    await click('[data-testid="nav-workspace"]');
    await waitFor(() => text().includes(`流式${before}`), 'returning session catches up with live source');
    assert.equal(query('[contenteditable="true"]'), editor, 'navigation preserves the native composer');
    await click('[data-testid="workspace-navigation-trigger"]');
    const destination = round % 2 ? 'analytics' : 'settings';
    await click(`[data-testid="nav-${destination}"]`);
    await waitFor(() => query(`[data-page="${destination}"]`), `${destination} returns with its content`);
    assert.doesNotMatch(text(), /Loading\.\.\./);
  }
  assert.deepEqual(sessionWrites, [], 'navigation neither stops nor sends input to the running session');
  assert.deepEqual(errors, [], `unexpected React errors: ${errors}`);
});
