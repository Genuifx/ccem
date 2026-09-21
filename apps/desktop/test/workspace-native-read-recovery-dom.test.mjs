import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build, stop } from 'esbuild';
import { JSDOM } from 'jsdom';
import { recoveryIpcPlugin } from './helpers/transcript-recovery-ipc.mjs';

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

test('the real native view recovers finals, exposes persistent failure, and supports Retry without a restart', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-native-read-dom-'));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map();
  const keys = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement',
    'HTMLTextAreaElement', 'DocumentFragment', 'Range', 'Text', 'ShadowRoot', 'NodeFilter', 'Event',
    'CustomEvent', 'MouseEvent', 'MutationObserver', 'localStorage', 'sessionStorage', 'SVGElement',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'];
  for (const key of keys) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key)
      ? dom.window[key].bind(dom.window) : dom.window[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  saved.set('ResizeObserver', Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'));
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ResizeObserver = globalThis.ResizeObserver;
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  saved.set('matchMedia', Object.getOwnPropertyDescriptor(globalThis, 'matchMedia'));
  globalThis.matchMedia = window.matchMedia;
  HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
  HTMLElement.prototype.scrollIntoView = function () {};
  window.__TAURI_INTERNALS__ = {
    invoke: async () => [], transformCallback: () => 0, unregisterCallback() {},
    metadata: { currentWindow: { label: 'fixture' }, currentWebview: { label: 'fixture' } },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  let fixture;
  t.after(async () => {
    fixture?.unmount();
    console.error = originalError;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const output = path.join(dir, 'fixture.cjs');
  await build({
    entryPoints: [path.join(desktop, 'test/fixtures/transcript-read-recovery.tsx')],
    outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
    target: 'node20', logLevel: 'silent', alias: { '@': path.join(desktop, 'src') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    plugins: [recoveryIpcPlugin(desktop), { name: 'fast-test-clock', setup(builder) {
      // Accelerate only deadlines/intervals. Use the actual view, commands,
      // leasing, commit effects and message components without stubbed hooks.
      builder.onLoad({ filter: /workspaceTranscriptBackfill\.ts$/ }, async ({ path: file }) => ({
        loader: 'ts', contents: (await fs.readFile(file, 'utf8')).replace('DEFAULT_TIMEOUT_MS = 8_000', 'DEFAULT_TIMEOUT_MS = 40'),
      }));
      builder.onLoad({ filter: /WorkspaceNativeSessionView\.tsx$/ }, async ({ path: file }) => ({
        loader: 'tsx', resolveDir: path.dirname(file),
        contents: (await fs.readFile(file, 'utf8'))
          .replace('ACTIVE_POLL_INTERVAL_MS = 140', 'ACTIVE_POLL_INTERVAL_MS = 15')
          .replace('IDLE_POLL_INTERVAL_MS = 700', 'IDLE_POLL_INTERVAL_MS = 20')
          .replace('FAILED_POLL_INTERVAL_MS = 5000', 'FAILED_POLL_INTERVAL_MS = 60'),
      }));
    } }],
  });
  fixture = require(output).mountRecoveryFixture(document.getElementById('root'), { stallInitial: true });
  const text = () => document.getElementById('root').textContent;
  const click = (id) => document.querySelector(`[data-testid="${id}"]`).click();
  await waitFor(() => text().includes('正在整理清单。') && text().includes('Write'), 'initial message and tool completion render');
  assert.ok(fixture.diagnostics().some((e) => e.name.endsWith('poll-error') && e.meta.afterSeq === null),
    'the initial read also recovers from a permanent stall');
  fixture.state.pending[0]();
  await delay(20);
  click('stall-once');
  await waitFor(() => fixture.diagnostics().some((e) => e.name.endsWith('poll-error') && e.meta.afterSeq === 4), 'the stalled read times out');
  await waitFor(() => text().includes('最终答复已同步，无需重启。'), 'automatic replacement renders final answer');
  await waitFor(() => !text().includes('新消息同步失败'), 'committed recovery clears the error');
  assert.equal(fixture.state.maxPending, 1);
  const trace = fixture.diagnostics();
  assert.ok(trace.some((e) => e.name.endsWith('poll-error') && e.meta.afterSeq === 4));
  assert.ok(trace.some((e) => e.name.endsWith('poll-response') && e.meta.receivedMaxSeq === 6));
  assert.ok(trace.some((e) => e.name.endsWith('poll-commit') && e.meta.acknowledgedSeq === 6));
  fixture.state.pending[0]();
  await delay(80);
  assert.equal(text().split('最终答复已同步，无需重启。').length - 1, 1, 'late result cannot duplicate the final');

  click('stall-always');
  await waitFor(() => fixture.state.pending.length === 2, 'only two unresolved reads may run');
  await waitFor(() => text().includes('新消息同步失败'), 'persistent error remains visible');
  const before = fixture.state.pageCalls;
  const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === '重试');
  assert.ok(retry, 'Retry is available in the real view');
  for (let i = 0; i < 5; i++) retry.click();
  await delay(150);
  assert.equal(fixture.state.pageCalls, before, 'repeated Retry must not add physical reads');
  click('other-session');
  await delay(80);
  click('other-session');
  await delay(150);
  assert.equal(fixture.state.requests.filter((request) => request.runtimeId === 'transcript-recovery-fixture').length, before);
  assert.ok(text().includes('最终答复已同步，无需重启。'), 'earlier messages stay visible');

  click('release');
  [...document.querySelectorAll('button')].find((button) => button.textContent === '重试')?.click();
  await waitFor(() => text().includes('持续故障后的答复。'), 'Retry restores the later answer after capacity is available');
  await waitFor(() => !text().includes('新消息同步失败'), 'recovery removes the warning');
  assert.equal(fixture.state.maxPending, 2);
  assert.ok(errors.every(([message, error]) => (
    ['Failed to poll native session:', 'Failed to load native input queue snapshot:'].includes(message)
    && ['TranscriptBackfillTimeoutError', 'TranscriptBackfillBusyError'].includes(error?.name)
  )), `unexpected component error: ${errors.map(([message, error]) => `${message} ${error}`).join(', ')}`);
});
