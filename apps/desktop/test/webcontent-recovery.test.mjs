import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const sourceDir = path.resolve(import.meta.dirname, '../src');

async function compile(file) {
  return ts.transpileModule(await fs.readFile(path.join(sourceDir, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function recoveryHarness({ native = true, invoke, heap, uuid, draftCounts } = {}) {
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  const bridge = invoke ?? (async () => ({ generation: 7, recovered: true }));
  const window = native ? { __TAURI_INTERNALS__: {} } : {};
  const document = {
    visibilityState: 'visible',
    querySelectorAll: (selector) => ({ length: selector === '*' ? 24 : 3 }),
  };
  const performance = heap === undefined ? {} : { memory: { usedJSHeapSize: heap } };
  const module = {};
  new Function('require', 'exports', 'window', 'document', 'performance', 'crypto', 'setTimeout', 'clearTimeout', 'console', await compile('lib/webcontentRecovery.ts'))(
    (name) => name === './recoveryDrafts'
      ? { recoveryDraftDiagnostics: () => draftCounts ?? { drafts: 0, uncertain: 0, failedWrites: 0 } }
      : { invoke(command, args) { calls.push({ command, args }); return bridge(command, args); } },
    module, window, document, performance, { randomUUID: uuid ?? (() => 'renderer-document-1') },
    (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    (id) => timers.delete(id),
    { warn() {} },
  );
  return {
    module, calls, timers, document,
    timeout() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

test('actual main bootstrap waits for the native document fence before mounting App', async () => {
  const gate = deferred();
  const harness = await recoveryHarness({ invoke: () => gate.promise });
  const mounts = [];
  function App() {}
  const document = { documentElement: { dataset: {} }, getElementById: () => ({ id: 'root' }) };
  const imports = {
    react: { default: { createElement: (...args) => args, StrictMode: 'strict' } },
    'react-dom/client': { default: { createRoot: (container) => ({ render: (tree) => mounts.push({ container, tree }) }) } },
    '@tauri-apps/api/window': { getCurrentWindow: () => ({ label: 'main' }) },
    './App': { default: App },
    './pages/PetOverlay': { PetOverlay() {} },
    './pages/TrayCockpit': { TrayCockpit() {} },
    './lib/performance': { initPerformanceMode() {} },
    './lib/perf-log': { initPerfLog() {} },
    './lib/windowRootRouting': { resolveDesktopWindowRoot: () => 'main' },
    './lib/webcontentRecovery': harness.module,
    './index.css': {},
  };
  new Function('require', 'exports', 'window', 'document', await compile('main.tsx'))(
    (name) => { assert.ok(name in imports, name); return imports[name]; }, {},
    { location: { search: '' } }, document,
  );
  assert.equal(mounts.length, 0);
  assert.equal(harness.module.isRecoveringWebcontent(), true, 'unresolved boot cannot authorize replay');
  gate.resolve({ generation: 7, recovered: true });
  await harness.module.initializeWebcontentRecovery();
  await Promise.resolve();
  assert.equal(mounts.length, 1);
  assert.equal(document.documentElement.dataset.window, 'main');
  assert.equal(harness.calls.length, 1, 'boot requests are single-flight');
});

test('fresh/recovered document identity and generation are forwarded to ready and samples', async () => {
  for (const recovered of [false, true]) {
    const harness = await recoveryHarness({ invoke: async () => ({ generation: 12, recovered }) });
    assert.equal(await harness.module.acknowledgeWebcontentReady(), false);
    await harness.module.sampleWebcontent();
    assert.equal(harness.calls.length, 0);
    await harness.module.initializeWebcontentRecovery();
    assert.equal(harness.module.isRecoveringWebcontent(), recovered);
    assert.equal(await harness.module.acknowledgeWebcontentReady(), true);
    await harness.module.sampleWebcontent();
    assert.deepEqual(harness.calls.map(({ command }) => command), [
      'webcontent_frontend_boot', 'webcontent_frontend_ready', 'webcontent_frontend_sample',
    ]);
    assert.deepEqual(harness.calls[1].args, { documentId: 'renderer-document-1', generation: 12 });
    assert.equal(harness.calls[2].args.documentId, 'renderer-document-1');
    assert.equal(harness.calls[2].args.generation, 12);
  }
});

test('rejected or malformed boot resolves for UI startup but keeps automatic replay fenced', async () => {
  for (const value of [null, {}, { generation: -1, recovered: false }, { generation: 1.5, recovered: false }, { generation: 1, recovered: 'false' }]) {
    const harness = await recoveryHarness({ invoke: async () => value });
    await harness.module.initializeWebcontentRecovery();
    assert.equal(harness.module.isRecoveringWebcontent(), true);
    assert.equal(await harness.module.acknowledgeWebcontentReady(), false);
    await harness.module.sampleWebcontent();
    assert.equal(harness.calls.length, 1, 'invalid boot must not produce ready/sample acknowledgements');
  }
  const harness = await recoveryHarness({ invoke: async () => { throw new Error('bridge unavailable'); } });
  await harness.module.initializeWebcontentRecovery();
  assert.equal(harness.module.isRecoveringWebcontent(), true);
});

test('late boot identity enables ready/telemetry after timeout without reauthorizing replay', async () => {
  const gate = deferred();
  const harness = await recoveryHarness({ invoke: (command) => command === 'webcontent_frontend_boot' ? gate.promise : Promise.resolve() });
  const boot = harness.module.initializeWebcontentRecovery();
  assert.equal([...harness.timers.values()][0].delay, 3000);
  harness.timeout();
  await boot;
  assert.equal(harness.module.isRecoveringWebcontent(), true);
  gate.resolve({ generation: 0, recovered: false });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.module.isRecoveringWebcontent(), true);
  assert.equal(await harness.module.acknowledgeWebcontentReady(), true);
  await harness.module.sampleWebcontent();
  assert.deepEqual(harness.calls.map(({ command }) => command), [
    'webcontent_frontend_boot', 'webcontent_frontend_ready', 'webcontent_frontend_sample',
  ]);
  assert.equal(harness.calls[1].args.generation, 0);
  assert.equal(harness.calls[2].args.documentId, 'renderer-document-1');
  assert.equal(harness.module.isRecoveringWebcontent(), true);
});

test('browser preview needs no native boot or recovery fence', async () => {
  const harness = await recoveryHarness({ native: false });
  await harness.module.initializeWebcontentRecovery();
  assert.equal(harness.module.isRecoveringWebcontent(), false);
  assert.equal(harness.calls.length, 0);
});

test('diagnostics contain aggregate scalar metrics only and remove unregistered readers', async () => {
  const harness = await recoveryHarness();
  const remove = harness.module.registerWebcontentSessionSample(() => ({
    rawEventCount: 10, projectedMessageCount: 4, toolResultChars: 120,
    prompt: 'PRIVATE PROMPT', events: [{ payload: 'PRIVATE EVENT' }], url: 'https://private.example',
  }));
  harness.module.registerWebcontentSessionSample(() => ({ rawEventCount: -1, projectedMessageCount: NaN, toolResultChars: 2.4 }));
  const sample = harness.module.collectWebcontentSample();
  assert.deepEqual(sample, {
    domNodeCount: 24, transcriptRowCount: 3, visible: true, heapUsedBytes: null,
    mountedSessionCount: 2, rawEventCount: 10, projectedMessageCount: 4, toolResultChars: 120,
    recoveryDraftCount: 0, recoveryUncertainSubmissionCount: 0, recoveryDraftWriteFailures: 0,
  });
  assert.doesNotMatch(JSON.stringify(sample), /PRIVATE|private\.example|prompt|payload/);
  remove();
  remove();
  const after = harness.module.collectWebcontentSample();
  assert.equal(after.mountedSessionCount, 1);
  assert.equal(after.rawEventCount, 0);
  assert.equal(after.projectedMessageCount, 0);
  assert.equal(after.toolResultChars, 0);
});

test('UUID failure resolves startup safely while keeping replay fenced and telemetry unacknowledged', async () => {
  const harness = await recoveryHarness({ uuid: () => { throw new Error('UUID unavailable'); } });
  await harness.module.initializeWebcontentRecovery();
  await harness.module.initializeWebcontentRecovery();
  assert.equal(harness.module.isRecoveringWebcontent(), true);
  assert.equal(await harness.module.acknowledgeWebcontentReady(), false);
  await harness.module.sampleWebcontent();
  assert.equal(harness.calls.length, 0);
});

test('draft telemetry exposes only aggregate recovery and persistence counters', async () => {
  const harness = await recoveryHarness({ draftCounts: {
    drafts: 2, uncertain: 1, failedWrites: 3, privateText: 'PRIVATE DRAFT', attachments: ['PRIVATE IMAGE'],
  } });
  const sample = harness.module.collectWebcontentSample();
  assert.equal(sample.recoveryDraftCount, 2);
  assert.equal(sample.recoveryUncertainSubmissionCount, 1);
  assert.equal(sample.recoveryDraftWriteFailures, 3);
  assert.doesNotMatch(JSON.stringify(sample), /PRIVATE|attachments|privateText/);
});

test('heap telemetry reports unsupported/invalid JSC values as null and valid byte counts verbatim', async () => {
  for (const heap of [undefined, NaN, -1, 1.2, Infinity, '400']) {
    const harness = await recoveryHarness({ heap });
    assert.equal(harness.module.collectWebcontentSample().heapUsedBytes, null);
  }
  const harness = await recoveryHarness({ heap: 40_000_000 });
  assert.equal(harness.module.collectWebcontentSample().heapUsedBytes, 40_000_000);
});

test('sampling is single-flight and releases its lease after failure', async () => {
  const gate = deferred();
  let firstSample = true;
  const harness = await recoveryHarness({ invoke: async (command) => {
    if (command === 'webcontent_frontend_boot') return { generation: 7, recovered: true };
    if (firstSample) { firstSample = false; return gate.promise; }
  } });
  await harness.module.initializeWebcontentRecovery();
  const first = harness.module.sampleWebcontent();
  await harness.module.sampleWebcontent();
  assert.equal(harness.calls.filter(({ command }) => command === 'webcontent_frontend_sample').length, 1);
  gate.reject(new Error('sample unavailable'));
  await assert.rejects(first, /sample unavailable/);
  await harness.module.sampleWebcontent();
  assert.equal(harness.calls.filter(({ command }) => command === 'webcontent_frontend_sample').length, 2);
});
