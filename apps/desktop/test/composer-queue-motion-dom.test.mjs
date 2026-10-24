import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(import.meta.dirname, '..');
const previousGlobals = new Map();
let dom, React, createRoot, gsap, QueueFixture;

test.before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    // Simulate a background native webview: timers run, but rAF never fires.
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  dom.window.matchMedia = () => ({ matches: false });
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ gsap } = require('gsap'));
  const compile = source => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const motion = {};
  new Function('require', 'exports', compile(await fs.readFile(path.join(desktopDir, 'src/lib/gsapMotion.ts'), 'utf8')))(require, motion);
  const queueMotion = {};
  new Function('require', 'exports', compile(await fs.readFile(path.join(desktopDir, 'src/components/workspace/composerQueueMotion.ts'), 'utf8')))(
    name => name === '@/lib/gsapMotion' ? motion : require(name), queueMotion,
  );

  // Execute the real dock component and its parent presence state. Extracting
  // these AST nodes isolates them from unrelated composer IPC/editor setup;
  // assertions below exercise rendered DOM and real React/GSAP callbacks.
  const source = await fs.readFile(path.join(desktopDir, 'src/components/workspace/WorkspaceSessionComposer.tsx'), 'utf8');
  const ast = ts.createSourceFile('composer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  const dock = functions.find(node => node.name?.text === 'ComposerQueueDock').getText(ast);
  const delivery = functions.find(node => node.name?.text === 'queuedDeliveryKeys').getText(ast);
  const statements = functions.find(node => node.name?.text === 'WorkspaceSessionComposer').body.statements;
  const first = statements.findIndex(node => node.getText(ast).startsWith('const [queueRows,'));
  const last = statements.findIndex(node => node.getText(ast).startsWith('const hasInterruptionPanel'));
  const presence = statements.slice(first, last).map(node => node.getText(ast)).join('\n');
  const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
  const icon = () => React.createElement('span');
  const bindings = { ...React, ...motion, ...queueMotion,
    useLocale: () => ({ t: key => key }), cn: (...values) => values.filter(Boolean).join(' '),
    Tooltip: passthrough, TooltipTrigger: passthrough, TooltipContent: passthrough,
    Button: ({ variant, size, children, ...props }) => React.createElement('button', props, children),
    MessageSquareQuote: icon, Zap: icon, AlertCircle: icon, LoaderCircle: icon, Clock: icon, Paperclip: icon, X: icon,
  };
  const exports = {};
  new Function('require', 'exports', ...Object.keys(bindings), compile(`
    ${delivery}
    ${dock}
    export function QueueFixture({ queuedMessages, onSteer }) {
      const queueFlightRef = useRef(null);
      ${presence}
      return hasComposerAttentionPanel ? <div data-attention-state="auxiliary">
        <ComposerQueueDock rows={queueRows} canFlush={false} canSteer onSteer={onSteer}
          flightSourceRef={queueFlightRef} onRowLeft={handleQueueRowLeft} listMaxHeightClassName="" />
      </div> : null;
    }
  `))(require, exports, ...Object.values(bindings));
  QueueFixture = exports.QueueFixture;
});

test.after(() => {
  gsap?.globalTimeline.clear();
  gsap?.ticker.sleep();
  dom?.window.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

test.afterEach(() => {
  gsap.globalTimeline.clear();
  gsap.ticker.sleep();
});

const message = { id: 'steered-row', text: 'steer this message', displayText: 'steer this message', flushable: false };

function mount(t) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = messages => React.act(() => root.render(React.createElement(QueueFixture,
    { queuedMessages: messages, onSteer: () => render([]) })));
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    React.act(() => root.unmount());
    container.remove();
  };
  t.after(unmount);
  render([message]);
  return { container, render, unmount };
}

test('admitted steer removes its queue row and dock even when animation frames are suspended', async (t) => {
  const view = mount(t);
  const row = view.container.querySelector('[data-ccem-composer-queued-message="steered-row"]');
  assert.ok(row);
  React.act(() => view.container.querySelector('[data-ccem-composer-queue-steer]').click());
  assert.equal(row.getAttribute('data-leaving'), '');
  assert.equal(row.getAttribute('aria-hidden'), 'true');
  assert.equal(row.isConnected, true, 'normal motion retains the row briefly for its exit');
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  assert.equal(Boolean(view.container.querySelector('[data-ccem-composer-queued-message]')), false, 'queue cleanup cannot depend on rAF');
  assert.equal(Boolean(view.container.querySelector('[data-ccem-composer-queue]')), false, 'the count header disappears with its last row');
  assert.equal(Boolean(view.container.querySelector('[data-attention-state]')), false, 'the empty attention dock does not remain');
});

test('normal queue exit still removes the row as soon as its tween finishes', (t) => {
  const view = mount(t);
  const row = view.container.querySelector('[data-ccem-composer-queued-message]');
  view.render([]);
  const tweens = gsap.getTweensOf(row);
  assert.equal(tweens.length, 1);
  React.act(() => { tweens[0].totalProgress(1); });
  assert.equal(Boolean(view.container.querySelector('[data-ccem-composer-queue]')), false);
  assert.equal(gsap.getTweensOf(row).length, 0);
});

test('an interrupted queue exit still completes semantic removal', async (t) => {
  const view = mount(t);
  const row = view.container.querySelector('[data-ccem-composer-queued-message]');
  view.render([]);
  gsap.killTweensOf(row);
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  assert.equal(Boolean(view.container.querySelector('[data-ccem-composer-queue]')), false);
});

test('a row that becomes active again cancels its old removal deadline', async (t) => {
  const view = mount(t);
  view.render([]);
  view.render([message]);
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  const row = view.container.querySelector('[data-ccem-composer-queued-message]');
  assert.ok(row);
  assert.equal(row.hasAttribute('data-leaving'), false);
  view.render([]);
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  assert.equal(Boolean(view.container.querySelector('[data-ccem-composer-queue]')), false);
});

test('unmount cancels the pending exit timer and tween', (t) => {
  const view = mount(t);
  const row = view.container.querySelector('[data-ccem-composer-queued-message]');
  const timers = new Set();
  const schedule = window.setTimeout;
  const cancel = window.clearTimeout;
  window.setTimeout = (callback, delay) => {
    const id = schedule(callback, delay);
    timers.add(id);
    return id;
  };
  window.clearTimeout = id => { timers.delete(id); cancel(id); };
  try {
    view.render([]);
    assert.equal(timers.size, 1);
    assert.equal(gsap.getTweensOf(row).length, 1);
    view.unmount();
    assert.equal(timers.size, 0, 'no removal callback survives the component');
    assert.equal(gsap.getTweensOf(row).length, 0);
  } finally {
    window.setTimeout = schedule;
    window.clearTimeout = cancel;
  }
});
