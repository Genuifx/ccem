import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const sourceDir = path.resolve(import.meta.dirname, '../src');
let dom;
let React;
let createRoot;
const previousGlobals = new Map();

test.before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
});

test.after(() => {
  dom?.window.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

async function loadQueueEffects() {
  const source = await fs.readFile(path.join(sourceDir, 'components/workspace/WorkspaceNativeSessionView.tsx'), 'utf8');
  const ast = ts.createSourceFile('native.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect') {
      const callback = node.arguments[0]?.getText(ast) ?? '';
      if (callback.includes('legacyFlushRevisionRef') || (callback.includes('flushQueuedMessages()') && callback.includes('180'))) {
        effects.push(node.getText(ast));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(effects.length, 2, 'load both current queue effects for execution');
  return transpile(effects.join(';\n'));
}

async function mountQueue({ recovered, pendingBoot = false } = {}) {
  const module = {};
  let resolveBoot;
  const bootReply = pendingBoot
    ? new Promise((resolve) => { resolveBoot = resolve; })
    : Promise.resolve({ generation: 2, recovered });
  const bootTimers = new Map();
  new Function('require', 'exports', 'window', 'setTimeout', 'clearTimeout', transpile(
    await fs.readFile(path.join(sourceDir, 'lib/webcontentRecovery.ts'), 'utf8'),
  ))(
    () => ({ invoke: () => bootReply }), module, { __TAURI_INTERNALS__: {} },
    (fn) => { bootTimers.set(1, fn); return 1; }, (id) => bootTimers.delete(id),
  );
  const boot = module.initializeWebcontentRecovery();
  if (!pendingBoot) await boot;
  const effectSource = await loadQueueEffects();
  const timers = new Map();
  let now = 0;
  let timerId = 0;
  let execute;
  const flushes = [];
  const sends = [];
  const queue = Object.freeze([Object.freeze({
    id: 'queued-1', text: 'persisted input',
    queuedDeliveryState: recovered === false ? 'pending' : 'delivery_uncertain',
  })]);
  const flushNativeSessionInputQueue = async (runtimeId) => { flushes.push(runtimeId); };
  const flushQueuedMessages = async () => { sends.push(queue[0].id); };
  const container = document.createElement('div');
  document.body.append(container);

  function Harness({ revision = 1, visible = true, sending = false, status = 'ready', queued = queue }) {
    const legacyFlushRevisionRef = React.useRef(null);
    const bindings = {
      useEffect: React.useEffect,
      isRecoveringWebcontent: module.isRecoveringWebcontent,
      legacyFlushRevisionRef,
      session: { runtime_id: 'runtime-1', status, lifecycle: {
        adapter: 'legacy_serial', active_command_id: null, queue_count: 1, state_revision: revision,
      } },
      isVisible: visible,
      flushNativeSessionInputQueue,
      queuedMessages: queued,
      isSending: sending,
      isTerminalStatus: (value) => value === 'stopped',
      flushQueuedMessages,
      window: {
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
      },
    };
    execute ??= new Function(...Object.keys(bindings), effectSource);
    execute(...Object.values(bindings));
    return React.createElement('div', null, ...queued.map((item) => React.createElement('div', {
      key: item.id, 'data-queued-message': item.id,
    }, `${item.text}:${item.queuedDeliveryState}`)));
  }

  const root = createRoot(container);
  return {
    module, container, queue, flushes, sends, timers,
    render(props = {}) { React.act(() => root.render(React.createElement(Harness, props))); },
    advance(ms) {
      now += ms;
      React.act(() => {
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now) { timers.delete(id); timer.fn(); }
        }
      });
    },
    async resolveBoot() { resolveBoot?.({ generation: 2, recovered: true }); await boot; },
    unmount() { React.act(() => root.unmount()); assert.equal(timers.size, 0); container.remove(); },
  };
}

test('recovered renderer reads persisted uncertain queue without flushing or sending on mount, timers, or rerender', async (t) => {
  const mounted = await mountQueue({ recovered: true });
  t.after(() => mounted.unmount());
  mounted.render();
  const queueBefore = JSON.stringify(mounted.queue);
  assert.match(mounted.container.textContent, /persisted input:delivery_uncertain/);
  mounted.advance(10_000);
  mounted.render({ revision: 2 });
  mounted.advance(10_000);
  mounted.render({ revision: 3, sending: true });
  mounted.render({ revision: 4, sending: false });
  mounted.advance(10_000);
  assert.deepEqual(mounted.flushes, []);
  assert.deepEqual(mounted.sends, []);
  assert.equal(mounted.timers.size, 0);
  assert.equal(JSON.stringify(mounted.queue), queueBefore);
  assert.equal(mounted.container.querySelectorAll('[data-queued-message]').length, 1);
});

test('unknown recovery fence suppresses replay even if session effects were mounted before handshake', async (t) => {
  const mounted = await mountQueue({ pendingBoot: true });
  t.after(() => mounted.unmount());
  mounted.render();
  mounted.advance(1000);
  assert.deepEqual(mounted.flushes, []);
  assert.deepEqual(mounted.sends, []);
  await mounted.resolveBoot();
  mounted.render({ revision: 2 });
  mounted.advance(1000);
  assert.deepEqual(mounted.flushes, []);
  assert.deepEqual(mounted.sends, []);
});

test('fresh renderer keeps one legacy flush per revision and the existing 180ms queued action', async (t) => {
  const mounted = await mountQueue({ recovered: false });
  t.after(() => mounted.unmount());
  mounted.render();
  assert.deepEqual(mounted.flushes, ['runtime-1']);
  mounted.advance(179);
  assert.deepEqual(mounted.sends, []);
  mounted.render();
  assert.deepEqual(mounted.flushes, ['runtime-1'], 'same revision is not flushed twice after rerender');
  mounted.advance(1);
  assert.deepEqual(mounted.sends, ['queued-1']);
  mounted.render({ revision: 2 });
  assert.deepEqual(mounted.flushes, ['runtime-1', 'runtime-1']);
  assert.equal(mounted.timers.size, 0, 'unchanged queued inputs do not create duplicate timers');
});

test('fresh renderer cancels queued timer while sending or when the component unmounts', async () => {
  const mounted = await mountQueue({ recovered: false });
  try {
    mounted.render();
    mounted.advance(100);
    mounted.render({ sending: true });
    mounted.advance(1000);
    assert.deepEqual(mounted.sends, []);
    mounted.render({ sending: false });
    assert.equal(mounted.timers.size, 1);
  } finally {
    mounted.unmount();
  }
  mounted.advance(1000);
  assert.deepEqual(mounted.sends, []);
});

async function loadSendActions(recovered, processing) {
  const source = await fs.readFile(path.join(sourceDir, 'components/workspace/WorkspaceNativeSessionView.tsx'), 'utf8');
  const ast = ts.createSourceFile('native.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ['flushQueuedMessages', 'handleSend'].includes(node.name.getText(ast))) {
      callbacks.set(node.name.getText(ast), node.initializer.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(callbacks.size, 2);
  const sent = [];
  const errors = [];
  const originalQueue = [{ id: 'old-persisted', text: 'OLD POSSIBLY ADMITTED', attachments: [], annotations: [] }];
  const queuedStateRef = { current: { runtimeId: 'runtime-1', messages: originalQueue } };
  const bindings = {
    useCallback: (callback) => callback,
    isRecoveringWebcontent: () => recovered,
    session: { runtime_id: 'runtime-1', provider: 'claude', status: processing ? 'running' : 'ready', project_dir: '/fixture' },
    queuedFlushLeaseRef: { current: null },
    queuedStateRef,
    readStoredGuidanceQueue: () => originalQueue,
    isSending: false,
    isProcessingTurn: processing,
    isTerminalStatus: () => false,
    waitForPendingEnvironmentUpdate: async () => true,
    collectQueuedPromptAnnotations: () => [],
    setQueuedMessages(update) {
      queuedStateRef.current.messages = typeof update === 'function' ? update(queuedStateRef.current.messages) : update;
    },
    sendPromptBatch: async (batch) => { sent.push(batch.map((prompt) => prompt.text)); },
    toast: { error: (message) => errors.push(message) },
    t: (key) => key,
    PromptAnnotationLimitError: class extends Error {},
    composerTextRef: { current: 'NEW EXPLICIT INPUT' },
    parseWorkspacePromptAnnotations: () => [],
    isWorkspaceCronCommand: () => false,
    buildWorkspaceCronAgentPrompt: () => null,
    makePersistableGuidanceMessage: (message) => message,
    composerPlanModeEnabled: false,
    planExitApprovalPrompt: null,
    hasHardBlockingAttention: false,
    hasQuickReplyPrompt: false,
    hasBlockingAttention: false,
    sendInteractivePromptReply: async () => { throw new Error('Unexpected interactive reply'); },
    setComposerPlanModeEnabled() {},
    sessionRuntimePermMode: 'dev',
  };
  const body = [...callbacks].map(([name, initializer]) => `const ${name} = ${initializer};`).join('\n');
  const actions = new Function(...Object.keys(bindings), `${transpile(body)}\nreturn { flushQueuedMessages, handleSend };`)(...Object.values(bindings));
  return { ...actions, sent, errors, queuedStateRef, originalQueue };
}

for (const processing of [false, true]) {
  test(`recovered ${processing ? 'busy' : 'ready'} session sends only new explicit input and preserves old queue`, async () => {
    const actions = await loadSendActions(true, processing);
    assert.equal(await actions.handleSend({ text: 'NEW EXPLICIT INPUT', attachments: [] }), true);
    assert.deepEqual(actions.sent, [['NEW EXPLICIT INPUT']]);
    assert.strictEqual(actions.queuedStateRef.current.messages, actions.originalQueue);
    assert.deepEqual(actions.errors, []);
  });
}

test('central legacy flush refuses implicit recovered replay but accepts explicit queue recovery', async () => {
  const actions = await loadSendActions(true, false);
  await actions.flushQueuedMessages();
  assert.deepEqual(actions.sent, []);
  assert.strictEqual(actions.queuedStateRef.current.messages, actions.originalQueue);
  assert.equal(await actions.flushQueuedMessages(true), true);
  assert.deepEqual(actions.sent, [['OLD POSSIBLY ADMITTED']]);
  assert.deepEqual(actions.queuedStateRef.current.messages, []);
});

test('fresh session still migrates legacy queue before a newly submitted message', async () => {
  const actions = await loadSendActions(false, false);
  assert.equal(await actions.handleSend({ text: 'NEW EXPLICIT INPUT', attachments: [] }), true);
  assert.deepEqual(actions.sent, [['OLD POSSIBLY ADMITTED'], ['NEW EXPLICIT INPUT']]);
  assert.deepEqual(actions.queuedStateRef.current.messages, []);
});

async function mountLifecycle({ initiallyReady = true, readyReplies = [true] } = {}) {
  const source = await fs.readFile(path.join(sourceDir, 'hooks/useWebcontentLifecycle.ts'), 'utf8');
  const timers = new Map();
  const frames = new Map();
  let nextId = 0;
  let now = 0;
  let acknowledgements = 0;
  let samples = 0;
  const module = {};
  const schedule = (fn, delay, interval = false) => {
    const id = ++nextId;
    timers.set(id, { fn, at: now + delay, delay, interval });
    return id;
  };
  new Function('require', 'exports', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', transpile(source))(
    (name) => name === 'react' ? React : {
      acknowledgeWebcontentReady: async () => {
        const result = readyReplies[Math.min(acknowledgements++, readyReplies.length - 1)];
        if (result instanceof Error) throw result;
        return result;
      },
      sampleWebcontent: async () => { samples += 1; },
    }, module,
    (fn) => { const id = ++nextId; frames.set(id, fn); return id; },
    (id) => frames.delete(id),
    (fn, delay) => schedule(fn, delay), (id) => timers.delete(id),
    (fn, delay) => schedule(fn, delay, true), (id) => timers.delete(id),
  );
  const container = document.createElement('div');
  document.body.append(container);
  function Harness({ ready }) {
    module.useWebcontentLifecycle(ready);
    return React.createElement('div', { hidden: true }, 'committed recovered app');
  }
  const root = createRoot(container);
  const mounted = {
    render(ready) { React.act(() => root.render(React.createElement(Harness, { ready }))); },
    async advance(ms) {
      now += ms;
      await React.act(async () => {
        for (const [id, timer] of [...timers]) {
          if (timer.at > now) continue;
          if (timer.interval) timer.at = now + timer.delay;
          else timers.delete(id);
          timer.fn();
        }
        await Promise.resolve();
      });
    },
    async paintFrame() {
      await React.act(async () => {
        for (const [id, frame] of [...frames]) { frames.delete(id); frame(now); }
        await Promise.resolve();
      });
    },
    counts: () => ({ acknowledgements, samples }),
    unmount() {
      React.act(() => root.unmount());
      assert.equal(timers.size, 0, 'cleanup cancels fallback, retry, and periodic sample');
      assert.equal(frames.size, 0, 'cleanup cancels pending paint callback');
      container.remove();
    },
  };
  mounted.render(initiallyReady);
  return mounted;
}

test('hidden recovered app acknowledges with frozen rAF and never duplicates ACK when painting resumes', async (t) => {
  const mounted = await mountLifecycle();
  t.after(() => mounted.unmount());
  await mounted.advance(999);
  assert.deepEqual(mounted.counts(), { acknowledgements: 0, samples: 0 });
  await mounted.advance(1);
  assert.deepEqual(mounted.counts(), { acknowledgements: 1, samples: 1 });
  await mounted.paintFrame();
  await mounted.paintFrame();
  assert.deepEqual(mounted.counts(), { acknowledgements: 1, samples: 1 });
});

test('ready lifecycle waits for committed readiness and retries false ACK after late boot identity', async (t) => {
  const mounted = await mountLifecycle({ initiallyReady: false, readyReplies: [false, true] });
  t.after(() => mounted.unmount());
  await mounted.advance(10_000);
  assert.deepEqual(mounted.counts(), { acknowledgements: 0, samples: 0 });
  mounted.render(true);
  await mounted.advance(1000);
  assert.deepEqual(mounted.counts(), { acknowledgements: 1, samples: 0 });
  await mounted.advance(2000);
  assert.deepEqual(mounted.counts(), { acknowledgements: 2, samples: 1 });
});

test('unmount cancels hidden-window ready fallback without acknowledging a removed app', async () => {
  const mounted = await mountLifecycle();
  mounted.unmount();
  await mounted.advance(5000);
  assert.deepEqual(mounted.counts(), { acknowledgements: 0, samples: 0 });
});

test('paint and fallback ready attempts retain only a cancellable retry after a missing boot identity', async () => {
  const mounted = await mountLifecycle({ readyReplies: [false] });
  await mounted.paintFrame();
  await mounted.paintFrame();
  assert.equal(mounted.counts().acknowledgements, 1);
  await mounted.advance(1000);
  mounted.unmount();
  const before = mounted.counts();
  await mounted.advance(5000);
  assert.deepEqual(mounted.counts(), before);
});
