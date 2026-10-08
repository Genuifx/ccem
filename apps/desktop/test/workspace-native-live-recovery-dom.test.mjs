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

test('live transcript commits and old partial ranges recover without switching or restarting', async (t) => {
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
  const originalDateNow = Date.now;
  console.error = (...args) => errors.push(args);
  let fixture;
  let publisher;
  t.after(async () => {
    clearInterval(publisher);
    held = false;
    Date.now = originalDateNow;
    fixture?.unmount();
    console.error = originalError;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    delete globalThis.__gateReactCallback;
    for (const callback of queued) originalImmediate(callback);
    stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  let held = false;
  const queued = [];
  const originalImmediate = globalThis.setImmediate;
  globalThis.__gateReactCallback = (callback) => held ? queued.push(callback) : originalImmediate(callback);
  const output = path.join(dir, 'fixture.cjs');
  await build({
    entryPoints: [path.join(desktop, 'test/fixtures/transcript-read-recovery.tsx')],
    outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
    target: 'node20', logLevel: 'silent', alias: { '@': path.join(desktop, 'src') },
    loader: { '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    plugins: [recoveryIpcPlugin(desktop), { name: 'scheduler-gate', setup(builder) {
      builder.onLoad({ filter: /scheduler\.production\.min\.js$/ }, async ({ path: file }) => ({
        loader: 'js', resolveDir: path.dirname(file),
        contents: 'var setImmediate = globalThis.__gateReactCallback;\n' + await fs.readFile(file, 'utf8'),
      }));
    } }, { name: 'fast-test-clock', setup(builder) {
      // Accelerate only deadlines/intervals. Use the actual view, commands,
      // leasing, commit effects and message components without stubbed hooks.
      builder.onLoad({ filter: /workspaceTranscriptCommitRecovery\.ts$/ }, async ({ path: file }) => ({
        loader: 'ts', resolveDir: path.dirname(file),
        contents: (await fs.readFile(file, 'utf8')).replace('TRANSCRIPT_COMMIT_DEADLINE_MS = 2_000', 'TRANSCRIPT_COMMIT_DEADLINE_MS = 80'),
      }));
      builder.onLoad({ filter: /WorkspaceNativeSessionView\.tsx$/ }, async ({ path: file }) => ({
        loader: 'tsx', resolveDir: path.dirname(file),
        contents: (await fs.readFile(file, 'utf8'))
          .replace('ACTIVE_POLL_INTERVAL_MS = 140', 'ACTIVE_POLL_INTERVAL_MS = 15')
          .replace('IDLE_POLL_INTERVAL_MS = 700', 'IDLE_POLL_INTERVAL_MS = 20')
          .replace('FAILED_POLL_INTERVAL_MS = 5000', 'FAILED_POLL_INTERVAL_MS = 60')
          .replace('PARTIAL_REPLAY_RETRY_BASE_MS = 2_000', 'PARTIAL_REPLAY_RETRY_BASE_MS = 120')
          .replace('PARTIAL_REPLAY_RETRY_MAX_MS = 60_000', 'PARTIAL_REPLAY_RETRY_MAX_MS = 400'),
      }));
    } }],
  });
  fixture = require(output).mountRecoveryFixture(document.getElementById('root'));
  const text = () => document.getElementById('root').textContent;
  const click = (id) => document.querySelector(`[data-testid="${id}"]`).click();
  await waitFor(() => text().includes('正在整理清单。') && text().includes('Write'), 'initial message and tool completion render');
  const count = (value) => text().split(value).length - 1;
  held = true;
  fixture.publish('提交超时后自动出现。');
  await waitFor(() => fixture.diagnostics().some((e) => e.name.endsWith('poll-response') && e.meta.receivedMaxSeq === 6), 'real IPC response arrived');
  assert.ok(!text().includes('提交超时后自动出现。'), 'held Scheduler has not committed the transition');
  // Keep appending while the first batch is stalled; the deadline cannot move.
  publisher = setInterval(() => fixture.publish('后续流式片段。'), 15);
  await waitFor(() => text().includes('提交超时后自动出现。'), 'watchdog commits without releasing Scheduler');
  clearInterval(publisher);
  assert.ok(held && queued.length > 0);
  assert.ok(fixture.diagnostics().some((e) => e.name.endsWith('commit-recovery')));
  assert.equal(fixture.diagnostics().filter((e) => e.name.endsWith('poll-response')
    && e.meta.afterSeq === 4).length, 1, 'one pending commit does not repeatedly reread or renew its deadline');
  held = false;
  for (const callback of queued.splice(0)) originalImmediate(callback);
  await waitFor(() => text().includes('后续流式片段。'), 'newer live messages follow the recovered commit');
  assert.equal(count('提交超时后自动出现。'), 1);

  const firstHole = fixture.state.events.length + 1;
  fixture.state.sparseSeqs = new Set([firstHole, firstHole + 1, firstHole + 2]);
  fixture.append([
    { type: 'user_prompt', text: '缺口里的旧问题。', image_count: 0 },
    { type: 'assistant_chunk', text: '缺口里的旧答复。' },
    { type: 'lifecycle', stage: 'turn_completed', detail: '' },
  ]);
  fixture.publish('缺口之后的新报告。');
  await waitFor(() => text().includes('缺口之后的新报告。') && text().includes('部分'), 'partial is visible alongside live report');
  assert.ok(!text().includes('缺口里的旧问题。'));
  await delay(650);
  assert.ok(text().includes('部分'), 'permanent sparse source does not clear the warning');
  const fullReads = fixture.state.requests.filter((request) => request.runtimeId === 'transcript-recovery-fixture' && request.afterSeq == null).length;
  assert.ok(fullReads <= 4, `automatic full replays back off: ${fullReads}`);
  fixture.publish('补录期间的新消息。');
  await waitFor(() => text().includes('补录期间的新消息。'), 'partial retries do not block live tail');

  // Snapshot can finish while Scheduler is held too. A newer partial past
  // its fixed horizon must survive; only a later covering replay may clear it.
  fixture.state.sparseSeqs.clear();
  fixture.state.deferBackfill = true;
  await waitFor(() => fixture.state.backfillReleases.length > 0, 'authoritative retry is in flight');
  const lateHole = fixture.state.events.length + 1;
  fixture.state.sparseSeqs = new Set([lateHole]);
  fixture.append([{ type: 'user_prompt', text: '并发的新缺口问题。', image_count: 0 }]);
  fixture.publish('并发缺口之后的报告。');
  await waitFor(() => text().includes('并发缺口之后的报告。'), 'new partial arrives beyond full replay snapshot');
  held = true;
  fixture.state.backfillReleases.shift()();
  await waitFor(() => text().includes('缺口里的旧问题。'), 'backfill also has commit recovery');
  assert.ok(text().includes('部分'), 'old success cannot clear a newer partial range');
  fixture.state.sparseSeqs.clear();
  await waitFor(() => text().includes('并发的新缺口问题。') && !text().includes('转录不可用'), 'later covering snapshot heals automatically');
  fixture.switchTo('other-fixture');
  await delay(140);
  fixture.switchTo('transcript-recovery-fixture');
  await waitFor(() => text().includes('缺口里的旧问题。') && text().includes('并发的新缺口问题。'),
    'committed event updates survive a hidden generation while Scheduler is still held');
  assert.ok(!text().includes('转录不可用'), 'switching a healed view does not roll it back to a partial fold');
  held = false;
  for (const callback of queued.splice(0)) originalImmediate(callback);
  await delay(100);
  assert.ok(!text().includes('转录不可用'), 'old queued partial updates cannot revive warning');
  for (const value of ['缺口里的旧问题。', '缺口里的旧答复。', '缺口之后的新报告。', '补录期间的新消息。', '并发的新缺口问题。']) assert.equal(count(value), 1, value);

  // A timer/queued transition from a hidden generation must become inert.
  held = true;
  fixture.publish('切换期间到达的消息。');
  await waitFor(() => fixture.diagnostics().some((e) => e.name.endsWith('poll-response') && e.meta.receivedMaxSeq === fixture.state.events.length), 'switch test has pending response');
  fixture.switchTo('other-fixture');
  const recoveryBefore = fixture.diagnostics().filter((e) => e.name.endsWith('commit-recovery') && e.meta.runtimeId === 'transcript-recovery-fixture').length;
  await delay(140);
  assert.equal(fixture.diagnostics().filter((e) => e.name.endsWith('commit-recovery') && e.meta.runtimeId === 'transcript-recovery-fixture').length, recoveryBefore, 'hidden generation cancels watchdog');
  assert.ok(!document.querySelector('[data-testid="other-pane"]')?.textContent.includes('切换期间到达的消息。'), 'other session receives no target data');
  fixture.switchTo('transcript-recovery-fixture');
  await waitFor(() => text().includes('切换期间到达的消息。'), 'shown generation re-reads pending message');
  held = false;
  for (const callback of queued.splice(0)) originalImmediate(callback);
  await delay(100);
  assert.equal(count('切换期间到达的消息。'), 1);

  fixture.state.sourceAvailable = false;
  fixture.publish('源暂不可用时的可读尾部。');
  await waitFor(() => text().includes('源暂不可用时的可读尾部。') && text().includes('转录不可用'), 'unavailable source retains warning and readable events');
  await delay(450);
  assert.ok(text().includes('转录不可用'), 'a partial full read cannot clear unavailable-source status');
  // Clock rollback must not turn a short automatic retry into a long pause.
  Date.now = () => 1;
  fixture.state.sourceAvailable = true;
  await waitFor(() => !text().includes('转录不可用'), 'source recovery uses monotonic retry deadlines');
  Date.now = originalDateNow;
  assert.equal(count('源暂不可用时的可读尾部。'), 1);
  assert.deepEqual(errors, [], `unexpected component errors: ${errors}`);
});
