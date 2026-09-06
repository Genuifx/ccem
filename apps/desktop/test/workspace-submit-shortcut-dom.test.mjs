import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const sourceDir = path.resolve(import.meta.dirname, '../src');
const [workspaceSource, appSource, hookSource] = await Promise.all([
  fs.readFile(path.join(sourceDir, 'pages/Workspace.tsx'), 'utf8'),
  fs.readFile(path.join(sourceDir, 'App.tsx'), 'utf8'),
  fs.readFile(path.join(sourceDir, 'hooks/useKeyboardShortcuts.ts'), 'utf8'),
]);
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS };

function compileInitializer(source, file, name) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) {
      initializer = node.initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(initializer, `Missing executable ${name} in ${file}`);
  return ts.transpileModule(`return ${initializer}`, { compilerOptions }).outputText;
}

const buildSubmit = new Function('useCallback', 'workspaceColumnRef',
  compileInitializer(workspaceSource, 'Workspace.tsx', 'handleWorkspaceSubmitShortcut'));
const buildWorkspaceShortcuts = new Function(
  'useMemo', 'handleOpenSearchShortcut', 'handleOpenProjectShortcut', 'handleWorkspaceSubmitShortcut',
  compileInitializer(workspaceSource, 'Workspace.tsx', 'shortcuts'),
);
const buildAppShortcuts = new Function(
  'useMemo', 'activeTab', 'handleLaunch', 'navigateToTab', 'requestQuit', 'surfaceBackgroundTerminalPartial',
  compileInitializer(appSource, 'App.tsx', 'globalShortcuts'),
);

let dom;
let React;
let createRoot;
let useKeyboardShortcuts;
const originalGlobals = new Map();

test.before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  const exports = {};
  const code = ts.transpileModule(hookSource, { compilerOptions }).outputText;
  new Function('require', 'exports', 'window', code)(require, exports, dom.window);
  ({ useKeyboardShortcuts } = exports);
});

test.after(() => {
  dom.window.close();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function setup(t) {
  const host = document.createElement('main');
  host.innerHTML = `
    <button data-workspace-composer-submit id="outside">outside</button>
    <section id="workspace">
      <button data-workspace-composer-submit id="hidden">hidden</button>
      <button id="stop">stop</button>
      <button data-workspace-composer-submit id="visible">send</button>
    </section>`;
  document.body.append(host);
  t.after(() => host.remove());
  const clicked = [];
  for (const button of host.querySelectorAll('button')) {
    // JSDOM has no layout; model the current display:none inactive-composer
    // contract while using real DOM click/disabled/event propagation semantics.
    button.getClientRects = () => button.id === 'hidden' ? [] : [{ width: 10, height: 10 }];
    button.addEventListener('click', () => clicked.push(button.id));
  }
  const ref = { current: host.querySelector('#workspace') };
  const submit = buildSubmit(callback => callback, ref);
  return { host, clicked, ref, submit };
}

test('workspace shortcut activates only the visible owned Composer send button', (t) => {
  const fixture = setup(t);
  fixture.submit();
  assert.deepEqual(fixture.clicked, ['visible']);
});

test('disabled send, stop-only view, and absent workspace cannot dispatch a hidden draft', (t) => {
  const fixture = setup(t);
  const visible = fixture.host.querySelector('#visible');
  visible.disabled = true;
  fixture.submit();
  assert.deepEqual(fixture.clicked, []);
  visible.remove();
  fixture.submit();
  assert.deepEqual(fixture.clicked, []);
  fixture.ref.current = null;
  fixture.submit();
  assert.deepEqual(fixture.clicked, []);
});

function mountShortcutOwners(t, fixture, initialTab) {
  const container = document.createElement('div');
  document.body.append(container);
  const actions = [];
  const handleLaunch = () => {
    actions.push('launch');
    return Promise.resolve();
  };
  const noop = () => {};

  function Owners({ activeTab }) {
    const submit = buildSubmit(React.useCallback, fixture.ref);
    const workspaceShortcuts = buildWorkspaceShortcuts(React.useMemo, noop, noop, submit);
    const globalShortcuts = buildAppShortcuts(React.useMemo, activeTab, handleLaunch, noop, noop, noop);
    // Keep both real hook instances mounted, as App and Workspace do. Switching
    // tabs must transfer Enter ownership and remove the previous listener.
    useKeyboardShortcuts(activeTab === 'workspace' ? workspaceShortcuts : {});
    useKeyboardShortcuts(globalShortcuts);
    return null;
  }

  const root = createRoot(container);
  function render(activeTab) {
    React.act(() => root.render(React.createElement(Owners, { activeTab })));
  }
  render(initialTab);
  t.after(() => {
    React.act(() => root.unmount());
    container.remove();
  });
  return {
    actions,
    render,
    press(key) {
      // A non-input target exercises the two competing window listeners;
      // focused PromptArea handles its own Enter and would hide this regression.
      const event = new dom.window.KeyboardEvent('keydown', {
        key, metaKey: true, bubbles: true, cancelable: true,
      });
      React.act(() => fixture.host.querySelector('#stop').dispatchEvent(event));
      assert.equal(event.defaultPrevented, true);
    },
  };
}

test('Cmd+Enter has one owner while changing between Workspace and other tabs', (t) => {
  const fixture = setup(t);
  const owners = mountShortcutOwners(t, fixture, 'workspace');
  owners.press('Enter');
  assert.deepEqual(fixture.clicked, ['visible']);
  assert.deepEqual(owners.actions, [], 'Workspace submit cannot also launch a terminal');

  owners.render('sessions');
  owners.press('Enter');
  assert.deepEqual(fixture.clicked, ['visible'], 'inactive Workspace cannot send its draft');
  assert.deepEqual(owners.actions, ['launch'], 'other tabs preserve the launch shortcut');

  owners.render('workspace');
  owners.press('Enter');
  assert.deepEqual(fixture.clicked, ['visible', 'visible']);
  assert.deepEqual(owners.actions, ['launch'], 'returning to Workspace removes App Enter ownership');
});

test('Cmd+N still launches once in Workspace and other tabs without submitting a draft', (t) => {
  const fixture = setup(t);
  const owners = mountShortcutOwners(t, fixture, 'workspace');
  owners.press('n');
  assert.deepEqual(owners.actions, ['launch']);
  assert.deepEqual(fixture.clicked, []);

  owners.render('sessions');
  owners.press('n');
  assert.deepEqual(owners.actions, ['launch', 'launch']);
  assert.deepEqual(fixture.clicked, []);
});
