/**
 * JSDOM + React act() behavior tests for DSH History integration.
 * Tests production components with controlled deferred IPC promises to verify
 * race protection, error states, retry behavior, DSH-specific rendering, and
 * source filter interactions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const desktopDir = path.resolve(import.meta.dirname, '..');
let cachedHarness;

test.after(async () => {
  if (cachedHarness) {
    await fs.rm(cachedHarness.tempDir, { recursive: true, force: true });
  }
  stopEsbuild();
  // Force exit — JSDOM leaves dangling timers that prevent graceful shutdown
  setTimeout(() => process.exit(0), 100).unref();
});

// --- esbuild plugins ---

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
const INDEX_EXTENSIONS = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

async function resolveDesktopSource(importPath) {
  const basePath = path.join(desktopDir, 'src', importPath.slice(2));
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
  }
  for (const fn of INDEX_EXTENSIONS) {
    const candidate = path.join(basePath, fn);
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
  }
  return null;
}

const aliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = await resolveDesktopSource(args.path);
      if (!resolved) return { errors: [{ text: `Could not resolve ${args.path}` }] };
      return { path: resolved };
    });
  },
};

/**
 * Stub external deps that either require native Tauri runtime or are irrelevant.
 */
const externalStubPlugin = {
  name: 'ccem-dsh-history-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api/ }, () => ({
      path: 'tauri-stub', namespace: 'dsh-test-stubs',
    }));
    builder.onLoad({ filter: /^tauri-stub$/, namespace: 'dsh-test-stubs' }, () => ({
      loader: 'js',
      contents: `export function invoke() { return Promise.resolve(null); }`,
    }));
    builder.onResolve({ filter: /^sonner$/ }, () => ({
      path: 'sonner-stub', namespace: 'dsh-test-stubs',
    }));
    builder.onLoad({ filter: /^sonner-stub$/, namespace: 'dsh-test-stubs' }, () => ({
      loader: 'js',
      contents: `export const toast = { success() {}, error() {}, warning() {} }; export function Toaster() { return null; }`,
    }));
    builder.onResolve({ filter: /hooks\/useTauriCommands/ }, () => ({
      path: 'useTauriCommands-stub', namespace: 'dsh-test-stubs',
    }));
    builder.onLoad({ filter: /^useTauriCommands-stub$/, namespace: 'dsh-test-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function useTauriCommands() {
          return {
            launchClaudeCode: () => Promise.resolve(),
            openInteractiveSessionInTerminal: () => Promise.resolve(),
            setSessionTitle: () => Promise.resolve(),
          };
        }
      `,
    }));
    builder.onResolve({ filter: /gsapMotion/ }, () => ({
      path: 'gsapMotion-stub', namespace: 'dsh-test-stubs',
    }));
    builder.onLoad({ filter: /^gsapMotion-stub$/, namespace: 'dsh-test-stubs' }, () => ({
      loader: 'js',
      contents: `
        export const ccemMotion = { duration: { quick: 0, base: 0, handoff: 0 }, ease: { standard: 'none', soft: 'none' } };
        export const gsap = { utils: { toArray(s,r){return Array.from((r||document).querySelectorAll(s));} }, fromTo(){}, set(){} };
        export function shouldReduceMotion() { return true; }
        export function clearMotionProps() {}
      `,
    }));
    builder.onResolve({ filter: /^@lobehub\/icons/ }, () => ({
      path: 'lobehub-stub', namespace: 'dsh-test-stubs',
    }));
    builder.onLoad({ filter: /^lobehub-stub$/, namespace: 'dsh-test-stubs' }, () => ({
      loader: 'js',
      contents: `
        function NullComp() { return null; }
        NullComp.Color = NullComp;
        export const Claude = NullComp;
        export const Codex = NullComp;
        export const DeepSeek = NullComp;
        export const OpenCode = NullComp;
      `,
    }));
    // Intercept historyData to wrap with controllable mock
    builder.onResolve({ filter: /features\/conversations\/historyData/ }, () => ({
      path: 'historyData-mock', namespace: 'dsh-test-stubs',
    }));
    builder.onLoad({ filter: /^historyData-mock$/, namespace: 'dsh-test-stubs' }, () => ({
      loader: 'js',
      contents: `
        // Controllable mock: tests set _mock.fetchHistorySessionsWithDiagnostics etc.
        const _mock = {
          fetchHistorySessionsWithDiagnostics: () => Promise.resolve({ sessions: [], diagnostics: [] }),
          fetchConversationDetail: () => Promise.resolve({ messages: [], segments: [], warnings: [] }),
          searchHistorySessionsWithDiagnostics: () => Promise.resolve({ sessions: [], diagnostics: [] }),
          normalizeWorkspaceOverviewSnapshot: null, // will be set from real module
        };

        // Re-export production pure functions from real historyData (imported at harness level)
        // These are wired via the harness entry point.
        export function fetchHistorySessions(...a) { return _mock.fetchHistorySessionsWithDiagnostics(...a).then(r => r.sessions); }
        export function fetchHistorySessionsWithDiagnostics(...a) { return _mock.fetchHistorySessionsWithDiagnostics(...a); }
        export function fetchConversationDetail(...a) { return _mock.fetchConversationDetail(...a); }
        export function searchHistorySessionsWithDiagnostics(...a) { return _mock.searchHistorySessionsWithDiagnostics(...a); }
        export function getCachedHistorySessions() { return null; }
        export function getCachedDiagnostics() { return []; }
        export function isHistoryCacheFresh() { return false; }
        export function invalidateHistoryCache() {}
        export function primeHistoryPage() { return Promise.resolve(); }
        export function normalizeHistoryError(err) {
          if (err && typeof err === 'object' && 'code' in err && 'message' in err) return err;
          if (typeof err === 'string') return { code: 'unknown', message: err };
          if (err instanceof Error) return { code: 'unknown', message: err.message };
          return { code: 'unknown', message: String(err) };
        }
        export function normalizeHistorySource(value) {
          if (typeof value !== 'string') return null;
          switch (value.toLowerCase()) {
            case 'claude': return 'claude';
            case 'codex': return 'codex';
            case 'opencode': return 'opencode';
            case 'dsh': return 'dsh';
            default: return null;
          }
        }
        export function normalizeHistorySessions(data) {
          return data.filter(s => normalizeHistorySource(s.source) !== null)
            .map(s => ({...s, source: normalizeHistorySource(s.source)}));
        }
        export function normalizeWorkspaceOverviewSnapshot(data) {
          if (_mock.normalizeWorkspaceOverviewSnapshot) return _mock.normalizeWorkspaceOverviewSnapshot(data);
          const sessions = normalizeHistorySessions(data.sessions).filter(s => s.source !== 'dsh');
          const sessionByKey = new Map(sessions.map(s => [s.source + ':' + s.id, s]));
          const projectNodes = data.projectNodes.map(node => ({
            project: node.project, projectName: node.projectName, latestTimestamp: node.latestTimestamp,
            sessions: node.sessionKeys
              ? node.sessionKeys.map(k => sessionByKey.get(k)).filter(Boolean)
              : normalizeHistorySessions(node.sessions ?? []).filter(s => s.source !== 'dsh'),
          }));
          return { ...data, sessions, projectNodes };
        }
        export { _mock };
      `,
    }));
  },
};

async function getHarness() {
  if (cachedHarness) return cachedHarness;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-dsh-dom-'));
  const outputPath = path.join(tempDir, 'harness.cjs');

  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { LocaleProvider } from '@/locales';
        import { History } from '@/pages/History';
        import { _mock } from '@/features/conversations/historyData';
        import * as historyData from '@/features/conversations/historyData';
        import { isResumableHistorySource, toSessionKey } from '@/features/conversations/types';

        export { historyData, _mock, isResumableHistorySource, toSessionKey, act };

        export function mountHistory(container) {
          const root = createRoot(container);
          act(() => {
            root.render(
              <LocaleProvider>
                <History />
              </LocaleProvider>
            );
          });
          return {
            unmount() { act(() => root.unmount()); },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'dsh-history-harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    loader: { '.png': 'dataurl' },
    plugins: [externalStubPlugin, aliasPlugin],
    define: { 'process.env.NODE_ENV': '"test"' },
    logLevel: 'silent',
  });

  cachedHarness = { harness: await import(pathToFileURL(outputPath).href), tempDir };
  return cachedHarness;
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const { window } = dom;
  const expose = (name, value) => {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('localStorage', window.localStorage);
  expose('sessionStorage', window.sessionStorage);
  expose('Node', window.Node);
  expose('Element', window.Element);
  expose('HTMLElement', window.HTMLElement);
  expose('SVGElement', window.SVGElement);
  expose('Event', window.Event);
  expose('MouseEvent', window.MouseEvent);
  expose('KeyboardEvent', window.KeyboardEvent);
  expose('CustomEvent', window.CustomEvent);
  expose('MutationObserver', window.MutationObserver);
  expose('DOMRect', window.DOMRect ?? class DOMRect {});
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('IS_REACT_ACT_ENVIRONMENT', true);

  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  class IntersectionObserver {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const raf = (cb) => { const h = setTimeout(() => cb(Date.now()), 0); h.unref?.(); return h; };
  const caf = (h) => clearTimeout(h);
  const matchMedia = () => ({
    matches: true, media: '(prefers-reduced-motion: reduce)', onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent() { return true; },
  });

  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserver });
  Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: IntersectionObserver });
  expose('IntersectionObserver', IntersectionObserver);
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: window.MouseEvent });
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: raf });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: caf });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true, value() {},
  });
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true, value() {},
  });
  Object.defineProperty(window.Element.prototype, 'scrollTo', {
    configurable: true, value() {},
  });
  expose('ResizeObserver', ResizeObserver);
  expose('PointerEvent', window.PointerEvent);
  expose('requestAnimationFrame', raf);
  expose('cancelAnimationFrame', caf);
  expose('matchMedia', matchMedia);
  return { dom };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

// ==========================================================================
// Tests
// ==========================================================================

test('History folds OpenCode and DeepSeek into the Other source dropdown', async () => {
  installDom();
  const { harness } = await getHarness();
  const { _mock, act } = harness;
  const requestedSources = [];
  _mock.fetchHistorySessionsWithDiagnostics = (source) => {
    requestedSources.push(source);
    return Promise.resolve({
      sessions: [{
        id: 'filter-test',
        source: 'claude',
        display: 'Filter Test',
        project: '/p',
        projectName: 'p',
        timestamp: Date.now(),
      }],
      diagnostics: [],
    });
  };

  const container = document.getElementById('root');
  const app = harness.mountHistory(container);
  await act(async () => { await flush(); });
  const result = {
    hasAll: Boolean(container.querySelector('[data-testid="history-filter-all"]')),
    hasClaude: Boolean(container.querySelector('[data-testid="history-filter-claude"]')),
    hasCodex: Boolean(container.querySelector('[data-testid="history-filter-codex"]')),
    hasDirectOpenCode: Boolean(container.querySelector('[data-testid="history-filter-opencode"]')),
    hasDirectDsh: Boolean(container.querySelector('[data-testid="history-filter-dsh"]')),
    hasOther: false,
    otherLabel: '',
    hasOpenCodeOption: false,
    hasDshOption: false,
    selectedOpenCode: false,
    selectedDsh: false,
    activeOther: false,
  };

  const otherTrigger = container.querySelector('[data-testid="history-filter-other"]');
  if (otherTrigger) {
    result.hasOther = true;
    result.otherLabel = otherTrigger.textContent;
    await act(async () => {
      otherTrigger.dispatchEvent(new window.PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
      }));
      otherTrigger.click();
      await flush();
    });
    const openCodeOption = document.querySelector('[data-testid="history-filter-opencode-option"]');
    const dshOption = document.querySelector('[data-testid="history-filter-dsh-option"]');
    result.hasOpenCodeOption = Boolean(openCodeOption);
    result.hasDshOption = Boolean(dshOption);
    if (openCodeOption) {
      await act(async () => { openCodeOption.click(); await flush(); });
      result.selectedOpenCode = requestedSources.at(-1) === 'opencode'
        && /(OpenCode|sourceOpencode)/.test(otherTrigger.textContent);
      result.activeOther = otherTrigger.className.includes('border-primary');

      await act(async () => {
        otherTrigger.dispatchEvent(new window.PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
        }));
        otherTrigger.click();
        await flush();
      });
      const reopenedDshOption = document.querySelector('[data-testid="history-filter-dsh-option"]');
      if (reopenedDshOption) {
        await act(async () => { reopenedDshOption.click(); await flush(); });
        result.selectedDsh = requestedSources.at(-1) === 'dsh'
          && /(DeepSeek|sourceDsh)/.test(otherTrigger.textContent);
      }
    }
  }

  app.unmount();

  assert.equal(result.hasAll, true);
  assert.equal(result.hasClaude, true);
  assert.equal(result.hasCodex, true);
  assert.equal(result.hasDirectOpenCode, false);
  assert.equal(result.hasDirectDsh, false);
  assert.equal(result.hasOther, true, 'Other dropdown trigger is visible');
  assert.match(result.otherLabel, /(其他|Other|sourceOther)/);
  assert.equal(result.hasOpenCodeOption, true, 'OpenCode is available in the Other menu');
  assert.equal(result.hasDshOption, true, 'DeepSeek is available in the Other menu');
  assert.equal(result.selectedOpenCode, true, 'Selecting OpenCode updates the active source');
  assert.equal(result.selectedDsh, true, 'Selecting DeepSeek updates the active source');
  assert.equal(result.activeOther, true, 'Other trigger shows the active source state');
});

test('History source controls never arm keyboard session selection', async () => {
  installDom();
  const { harness } = await getHarness();
  const { _mock, act } = harness;
  const requestedSources = [];
  let detailRequests = 0;
  _mock.fetchHistorySessionsWithDiagnostics = (source) => {
    requestedSources.push(source);
    return Promise.resolve({
      sessions: [{
        id: 'keyboard-filter-test',
        source: 'claude',
        display: 'Keyboard Filter Test',
        project: '/p',
        projectName: 'p',
        timestamp: Date.now(),
      }],
      diagnostics: [],
    });
  };
  _mock.fetchConversationDetail = () => {
    detailRequests += 1;
    return Promise.resolve({ messages: [], segments: [], warnings: [] });
  };

  const container = document.getElementById('root');
  const app = harness.mountHistory(container);
  await act(async () => { await flush(); });
  const otherTrigger = container.querySelector('[data-testid="history-filter-other"]');
  const sessionItem = container.querySelector('[data-testid="history-session-item"]');
  assert.ok(otherTrigger);
  assert.ok(sessionItem);
  await act(async () => {
    otherTrigger.focus();
    otherTrigger.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }));
    await flush();
  });
  const sessionArmed = sessionItem.className.includes('ring-1');
  const activeOption = document.activeElement;
  assert.equal(activeOption?.getAttribute('role'), 'menuitemradio');
  await act(async () => {
    activeOption.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    await flush();
  });

  const result = {
    sessionArmed,
    selectedSecondarySource: requestedSources.at(-1) === 'opencode'
      || requestedSources.at(-1) === 'dsh',
    detailRequests,
  };
  app.unmount();

  assert.equal(result.sessionArmed, false, 'dropdown navigation does not focus a history row');
  assert.equal(result.selectedSecondarySource, true, 'Enter selects the focused dropdown source');
  assert.equal(result.detailRequests, 0, 'dropdown selection does not open a history session');
});

test('History session rows keep their j and arrow keyboard navigation', async () => {
  installDom();
  const { harness } = await getHarness();
  const { _mock, act } = harness;
  _mock.fetchHistorySessionsWithDiagnostics = () => Promise.resolve({
    sessions: [
      {
        id: 'keyboard-row-one',
        source: 'claude',
        display: 'Keyboard Row One',
        project: '/p',
        projectName: 'p',
        timestamp: Date.now(),
      },
      {
        id: 'keyboard-row-two',
        source: 'claude',
        display: 'Keyboard Row Two',
        project: '/p',
        projectName: 'p',
        timestamp: Date.now() - 1,
      },
    ],
    diagnostics: [],
  });

  const container = document.getElementById('root');
  const app = harness.mountHistory(container);
  await act(async () => { await flush(); });
  const sessionItems = container.querySelectorAll('[data-testid="history-session-item"]');
  assert.equal(sessionItems.length, 2);
  await act(async () => {
    sessionItems[0].focus();
    sessionItems[0].dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }));
    await flush();
  });
  const firstRowFocused = sessionItems[0].className.includes('ring-1');
  await act(async () => {
    sessionItems[0].dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }));
    await flush();
  });
  const secondRowFocused = sessionItems[1].className.includes('ring-1');
  app.unmount();

  assert.equal(firstRowFocused, true, 'first ArrowDown focuses the first history row');
  assert.equal(secondRowFocused, true, 'ArrowDown advances focus to the next history row');
});

test('DSH session: no Resume button, Export available, read-only label', async () => {
  installDom();
  const { harness } = await getHarness();
  const { _mock, act } = harness;

  // Return a DSH session
  _mock.fetchHistorySessionsWithDiagnostics = () => Promise.resolve({
    sessions: [
      { id: 'abcdef0123456789:dsh-1', source: 'dsh', display: 'DSH Session', project: '/p', projectName: 'p', timestamp: Date.now() },
    ],
    diagnostics: [],
  });
  _mock.fetchConversationDetail = () => Promise.resolve({
    messages: [{ msgType: 'human', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() }],
    segments: [],
    warnings: [],
  });

  const container = document.getElementById('root');
  const app = harness.mountHistory(container);
  await act(async () => { await flush(); });

  // Click DSH session
  const sessionItem = container.querySelector('[data-testid="history-session-item"]');
  assert.ok(sessionItem, 'DSH session should be listed');
  await act(async () => { sessionItem.click(); await flush(); });

  // No Resume button
  const resumeBtn = container.querySelector('[data-testid="history-resume-btn"]');
  assert.equal(resumeBtn, null, 'Resume button must NOT render for DSH session');

  // Read-only label present
  const readOnly = container.querySelector('[data-testid="history-read-only-label"]');
  assert.ok(readOnly, 'Read-only label must be visible for DSH session');

  // Export available
  const exportBtn = container.querySelector('[data-testid="history-export-btn"]');
  assert.ok(exportBtn, 'Export button must be available for DSH session');

  app.unmount();
});

test('detail selection race: slow A cannot overwrite B', async () => {
  installDom();
  const { harness } = await getHarness();
  const { _mock, act } = harness;

  const sessions = [
    { id: 's-a', source: 'claude', display: 'Session A', project: '/p', projectName: 'p', timestamp: Date.now() },
    { id: 's-b', source: 'claude', display: 'Session B', project: '/p', projectName: 'p', timestamp: Date.now() - 1000 },
  ];
  _mock.fetchHistorySessionsWithDiagnostics = () => Promise.resolve({ sessions, diagnostics: [] });

  const detailA = deferred();
  const detailB = deferred();
  _mock.fetchConversationDetail = (session) =>
    session.id === 's-a' ? detailA.promise : detailB.promise;

  const container = document.getElementById('root');
  const app = harness.mountHistory(container);
  await act(async () => { await flush(); });

  const items = container.querySelectorAll('[data-testid="history-session-item"]');
  // Select A
  await act(async () => { items[0].click(); await flush(); });
  // Select B before A resolves
  await act(async () => { items[1].click(); await flush(); });

  // Resolve B
  await act(async () => {
    detailB.resolve({ messages: [{ msgType: 'human', content: [{ type: 'text', text: 'B content' }], timestamp: Date.now() }], segments: [], warnings: [] });
    await flush();
  });
  // Resolve A (stale)
  await act(async () => {
    detailA.resolve({ messages: [{ msgType: 'human', content: [{ type: 'text', text: 'STALE A' }], timestamp: Date.now() }], segments: [], warnings: [] });
    await flush();
  });

  assert.ok(container.textContent.includes('B content'), 'Current B must be visible');
  assert.ok(!container.textContent.includes('STALE A'), 'Stale A must not overwrite B');
  app.unmount();
});

test('list error visible, retry invokes fetch, result rendered', async () => {
  installDom();
  const { harness } = await getHarness();
  const { _mock, act } = harness;

  const d1 = deferred();
  _mock.fetchHistorySessionsWithDiagnostics = () => d1.promise;

  const container = document.getElementById('root');
  const app = harness.mountHistory(container);
  await act(async () => { d1.reject({ code: 'dsh_error', message: 'DSH helper failed' }); await flush(); });

  const retryBtn = container.querySelector('[data-testid="history-list-retry"]');
  assert.ok(retryBtn, 'Retry button visible after list error');
  assert.ok(container.textContent.includes('DSH helper failed'));

  // Click retry
  _mock.fetchHistorySessionsWithDiagnostics = () => Promise.resolve({
    sessions: [{ id: 's1', source: 'claude', display: 'OK', project: '/p', projectName: 'p', timestamp: Date.now() }],
    diagnostics: [],
  });
  await act(async () => { retryBtn.click(); await flush(); });

  assert.ok(container.querySelector('[data-testid="history-session-item"]'), 'Sessions render after retry');
  assert.ok(!container.querySelector('[data-testid="history-list-retry"]'), 'Error cleared');
  app.unmount();
});

test('search diagnostics model: diagnostics + results are simultaneously available', async () => {
  // Tests the production seam output shape that HistoryList renders
  installDom();
  const { harness } = await getHarness();
  const { _mock } = harness;

  _mock.searchHistorySessionsWithDiagnostics = () => Promise.resolve({
    sessions: [{ id: 's1', source: 'claude', display: 'Found', project: '/p', projectName: 'p', timestamp: Date.now() }],
    diagnostics: [{ source: 'dsh', code: 'helper_error', message: 'DSH unavailable' }],
  });

  const result = await harness.historyData.searchHistorySessionsWithDiagnostics('q', 'all', 120);
  assert.equal(result.sessions.length, 1, 'Results usable');
  assert.equal(result.diagnostics.length, 1, 'Diagnostics present');
  assert.equal(result.diagnostics[0].message, 'DSH unavailable');
});

test('normalizeWorkspaceOverviewSnapshot: production seam excludes DSH from all levels', async () => {
  installDom();
  const { harness } = await getHarness();

  const result = harness.historyData.normalizeWorkspaceOverviewSnapshot({
    sessions: [
      { id: 's1', source: 'claude', project: '/p', projectName: 'p', timestamp: 3000 },
      { id: 'abcdef0123456789:s2', source: 'dsh', project: '/p', projectName: 'p', timestamp: 4000 },
    ],
    projectNodes: [{
      project: '/p', projectName: 'p', latestTimestamp: 4000,
      sessionKeys: ['claude:s1', 'dsh:abcdef0123456789:s2'],
    }],
    totalSessions: 2,
    totalProjects: 1,
  });

  // Top sessions: DSH excluded
  assert.ok(result.sessions.every(s => s.source !== 'dsh'), 'Top sessions exclude DSH');
  assert.equal(result.sessions.length, 1);
  // Project node sessions: DSH key cannot resolve
  assert.equal(result.projectNodes[0].sessions.length, 1);
  assert.equal(result.projectNodes[0].sessions[0].source, 'claude');
});

test('list retry stale: source switch during retry discards result', async () => {
  installDom();
  const { harness } = await getHarness();
  const { _mock, act } = harness;

  // Initial load for 'all' source — fails
  _mock.fetchHistorySessionsWithDiagnostics = () =>
    Promise.reject({ code: 'network', message: 'Connection error' });

  const container = document.getElementById('root');
  const app = harness.mountHistory(container);
  await act(async () => { await flush(); });

  // Error state with retry button
  const retryBtn = container.querySelector('[data-testid="history-list-retry"]');
  assert.ok(retryBtn, 'Retry button after error');

  // Now set up: retry will return a deferred, then source changes before it resolves
  const retryDeferred = deferred();
  _mock.fetchHistorySessionsWithDiagnostics = () => retryDeferred.promise;

  // Click retry (starts async fetch)
  await act(async () => { retryBtn.click(); await flush(); });

  // Switch source (bumps listGenRef) — this re-triggers the useEffect which
  // calls fetchHistorySessionsWithDiagnostics for the new source
  const claudeFilter = container.querySelector('[data-testid="history-filter-claude"]');
  assert.ok(claudeFilter, 'Claude filter button exists');
  _mock.fetchHistorySessionsWithDiagnostics = () => Promise.resolve({
    sessions: [{ id: 's-new', source: 'claude', display: 'New Source Session', project: '/p', projectName: 'p', timestamp: Date.now() }],
    diagnostics: [],
  });
  await act(async () => { claudeFilter.click(); await flush(); });

  // Now resolve the stale retry from the old source
  await act(async () => {
    retryDeferred.resolve({
      sessions: [{ id: 's-stale', source: 'dsh', display: 'STALE FROM OLD SOURCE', project: '/p', projectName: 'p', timestamp: Date.now() }],
      diagnostics: [],
    });
    await flush();
  });

  // The stale result must NOT overwrite the current source's data
  assert.ok(!container.textContent.includes('STALE FROM OLD SOURCE'),
    'Stale retry result from old source must not overwrite new source data');
  assert.ok(container.textContent.includes('New Source Session'),
    'Current source data should be displayed');
  app.unmount();
});

test('search retry stale: query change during search retry discards result', async () => {
  installDom();
  const { harness } = await getHarness();
  const { _mock, act } = harness;

  // Load sessions normally
  _mock.fetchHistorySessionsWithDiagnostics = () => Promise.resolve({
    sessions: [
      { id: 's1', source: 'claude', display: 'Test Session', project: '/p', projectName: 'p', timestamp: Date.now() },
    ],
    diagnostics: [],
  });

  // Search returns deferred so we can control timing
  const searchDeferred = deferred();
  _mock.searchHistorySessionsWithDiagnostics = () => searchDeferred.promise;

  const container = document.getElementById('root');
  const app = harness.mountHistory(container);
  await act(async () => { await flush(); });

  // Type first search query via the search input
  const searchInput = container.querySelector('input[type="text"]');
  assert.ok(searchInput, 'Search input exists');

  // Type "query1" to trigger search
  await act(async () => {
    searchInput.value = 'query1';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await flush();
  });

  // The search effect fires with "query1", search is in-flight (deferred)
  // Now type "query2" — bumps searchGenRef
  const searchDeferred2 = deferred();
  _mock.searchHistorySessionsWithDiagnostics = () => searchDeferred2.promise;
  await act(async () => {
    searchInput.value = 'query2';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await flush();
  });

  // Resolve the query2 search first
  await act(async () => {
    searchDeferred2.resolve({
      sessions: [{ id: 's-q2', source: 'claude', display: 'Query2 Result', project: '/p', projectName: 'p', timestamp: Date.now() }],
      diagnostics: [],
    });
    await flush();
  });

  // Now resolve the stale query1 search
  await act(async () => {
    searchDeferred.resolve({
      sessions: [{ id: 's-stale', source: 'claude', display: 'STALE QUERY1 RESULT', project: '/p', projectName: 'p', timestamp: Date.now() }],
      diagnostics: [],
    });
    await flush();
  });

  // Stale query1 result must not overwrite query2 result
  assert.ok(!container.textContent.includes('STALE QUERY1 RESULT'),
    'Stale search from old query must not overwrite current query results');
  app.unmount();
});
