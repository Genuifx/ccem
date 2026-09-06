import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const sourceDir = path.resolve(import.meta.dirname, '../src');
const React = require('react');
const { createRoot } = require('react-dom/client');

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

async function appStartupBindings() {
  const source = await fs.readFile(path.join(sourceDir, 'App.tsx'), 'utf8');
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const app = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AppContent');
  assert.ok(app?.body);
  const wanted = app.body.statements.filter(node => {
    const text = node.getText(ast);
    return (ts.isVariableStatement(node) && (
      text.includes('[startupSplashVisible,') || text.includes('= useStartup(')
      || text.includes('const recoveryNoticeShownRef') || text.includes('const handleStartupSplashExitComplete')
    )) || (ts.isExpressionStatement(node) && (
      text.startsWith('useWebcontentLifecycle(')
      || (text.startsWith('useEffect(') && text.includes('recoveryNoticeShownRef'))
    ));
  });
  assert.equal(wanted.length, 6, 'execute the actual App startup, liveness, notice, and splash-exit bindings');
  let workspaceGate;
  function visit(node) {
    if (ts.isConditionalExpression(node) && node.whenTrue.getText(ast).trim().startsWith('(<AppLayout')) {
      workspaceGate = node.condition.getText(ast);
    }
    if (ts.isConditionalExpression(node) && /<AppLayout\s/.test(node.whenTrue.getText(ast))) {
      workspaceGate ??= node.condition.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(app);
  assert.ok(workspaceGate, 'execute the real App workspace visibility condition');
  return { statements: wanted.map(node => node.getText(ast)).join('\n'), workspaceGate };
}

async function mountStartupRecovery() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map();
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  let now = 0;
  let nextId = 0;
  let nativePhase = 'restoringSessions';
  const timers = new Map();
  const frames = new Map();
  const calls = [];
  const notices = [];
  const schedule = (fn, delay, interval = false) => {
    const id = ++nextId;
    timers.set(id, { fn, at: now + delay, delay, interval });
    return id;
  };
  const clear = id => timers.delete(id);
  const browser = { __TAURI_INTERNALS__: {}, setTimeout: schedule, clearTimeout: clear };
  const performance = { now: () => now };
  const invoke = async (command, args) => {
    calls.push({ command, args, at: now });
    if (command === 'get_startup_status') return nativePhase;
    if (command === 'webcontent_frontend_boot') return { generation: 7, recovered: true };
    if (command === 'webcontent_frontend_ready') return true;
  };
  const recovery = {};
  new Function('require', 'exports', 'window', 'document', 'performance', 'crypto', 'setTimeout', 'clearTimeout', transpile(
    await fs.readFile(path.join(sourceDir, 'lib/webcontentRecovery.ts'), 'utf8'),
  ))(
    name => name === './recoveryDrafts'
      ? { recoveryDraftDiagnostics: () => ({ drafts: 0, uncertain: 0, failedWrites: 0 }) }
      : { invoke },
    recovery, browser, dom.window.document, performance,
    { randomUUID: () => '11111111-1111-4111-8111-111111111111' }, schedule, clear,
  );
  await recovery.initializeWebcontentRecovery();
  const startup = {};
  new Function('require', 'exports', 'window', 'performance', transpile(
    await fs.readFile(path.join(sourceDir, 'hooks/useStartup.ts'), 'utf8'),
  ))(name => name === 'react' ? React : { invoke }, startup, browser, performance);
  const lifecycle = {};
  new Function('require', 'exports', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', transpile(
    await fs.readFile(path.join(sourceDir, 'hooks/useWebcontentLifecycle.ts'), 'utf8'),
  ))(
    name => name === 'react' ? React : recovery, lifecycle,
    fn => { const id = ++nextId; frames.set(id, fn); return id; }, id => frames.delete(id),
    schedule, clear, (fn, delay) => schedule(fn, delay, true), clear,
  );
  const bindings = await appStartupBindings();
  const state = {};
  const Harness = new Function(
    'React', 'useState', 'useRef', 'useEffect', 'useCallback', 'useStartup', 'useWebcontentLifecycle',
    'refreshCriticalData', 'hasRecoveredWebcontent', 'recoveryDraftDiagnostics', 'toast', 't', 'state',
    transpile(`
      return function Harness() {
        ${bindings.statements}
        state.finishSplash = handleStartupSplashExitComplete;
        return React.createElement('div', null,
          ${bindings.workspaceGate}
            ? React.createElement('button', { 'data-workspace': true }, 'New conversation')
            : React.createElement('div', { 'data-startup-progress': startupPhase }, startupPhase),
          startupSplashVisible ? React.createElement('div', { 'data-splash': true }, 'Startup') : null);
      }
    `),
  )(
    React, React.useState, React.useRef, React.useEffect, React.useCallback,
    startup.useStartup, lifecycle.useWebcontentLifecycle, async () => {},
    recovery.hasRecoveredWebcontent, () => ({ uncertain: 0 }),
    { info: notice => notices.push(notice) }, key => key, state,
  );
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  await React.act(async () => { root.render(React.createElement(Harness)); });
  return {
    container, calls, notices,
    setNativePhase(value) { nativePhase = value; },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.delay;
        else timers.delete(id);
        await React.act(async () => { timer.fn(); await Promise.resolve(); });
      }
      now = target;
    },
    finishSplash() { React.act(() => state.finishSplash()); },
    unmount() {
      React.act(() => root.unmount());
      assert.equal(timers.size, 0, 'startup and renderer lifecycle dispose their timers');
      assert.equal(frames.size, 0, 'renderer lifecycle disposes frozen paint callbacks');
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test('recovered renderer acknowledges a committed startup screen before the 20s watchdog without opening the workspace', async (t) => {
  const mounted = await mountStartupRecovery();
  t.after(() => mounted.unmount());
  assert.equal(mounted.container.querySelector('[data-workspace]'), null);
  assert.equal(mounted.container.querySelector('[data-startup-progress]').textContent, 'restoringSessions');
  await mounted.advance(1000);
  const acknowledgements = () => mounted.calls.filter(call => call.command === 'webcontent_frontend_ready');
  assert.equal(acknowledgements().length, 1);
  assert.equal(acknowledgements()[0].at, 1000, 'frozen paint scheduling still acknowledges before the native watchdog');
  await mounted.advance(29_000);
  assert.equal(acknowledgements().length, 1, 'polling healthy native startup does not duplicate renderer ACKs');
  assert.equal(mounted.container.querySelector('[data-workspace]'), null, 'native startup remains the admission gate after 30s');
  assert.equal(mounted.container.querySelector('[data-startup-progress]').textContent, 'restoringSessions');
  assert.deepEqual(mounted.notices, [], 'do not claim full recovery while native startup is pending');

  mounted.setNativePhase('ready');
  await mounted.advance(250);
  assert.ok(mounted.container.querySelector('[data-workspace]'));
  assert.deepEqual(mounted.notices, [], 'wait until the splash has exited before showing recovery notice');
  mounted.finishSplash();
  assert.deepEqual(mounted.notices, ['common.webcontentRecovered']);
  await mounted.advance(2000);
  assert.equal(acknowledgements().length, 1);
  assert.deepEqual(mounted.notices, ['common.webcontentRecovered']);
});

test('failed native startup remains gated even though its renderer is responsive', async (t) => {
  const mounted = await mountStartupRecovery();
  t.after(() => mounted.unmount());
  mounted.setNativePhase('failed');
  await mounted.advance(30_000);
  assert.equal(mounted.container.querySelector('[data-workspace]'), null);
  assert.equal(mounted.container.querySelector('[data-startup-progress]').textContent, 'failed');
  assert.equal(mounted.calls.filter(call => call.command === 'webcontent_frontend_ready').length, 1);
  assert.deepEqual(mounted.notices, []);
});
