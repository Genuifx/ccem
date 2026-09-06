import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';

const desktopDir = path.resolve(import.meta.dirname, '..');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const previousGlobals = new Map();
function expose(name, value) {
  previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
for (const name of [
  'window', 'document', 'navigator', 'localStorage', 'Node', 'Element', 'HTMLElement',
  'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'CustomEvent', 'KeyboardEvent',
  'MouseEvent', 'MutationObserver', 'NodeFilter', 'DOMRect',
]) {
  expose(name, name === 'window' ? dom.window : dom.window[name]);
}
expose('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
expose('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
expose('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
expose('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
// Bundled React's async act uses the browser MessageChannel fallback. Match the
// other DOM harnesses without leaving Node worker-thread ports alive after tests.
expose('MessageChannel', class {
  constructor() {
    this.port1 = { onmessage: null };
    this.port2 = { postMessage: (data) => setImmediate(() => this.port1.onmessage?.({ data })) };
  }
});
expose('IS_REACT_ACT_ENVIRONMENT', true);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-navigation-'));
const outputPath = path.join(tempDir, 'harness.cjs');
await build({
  stdin: {
    contents: `
      import React, { act, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { AppLayout } from '@/components/layout/AppLayout';
      import { LocaleProvider } from '@/locales';
      export { act };
      export function mount(container, initialTab = 'workspace') {
        let navigate;
        function Harness() {
          const [tab, setTab] = useState(initialTab);
          navigate = setTab;
          return (
            <LocaleProvider>
              <AppLayout activeTab={tab} onTabChange={setTab} fullBleed>
                <div data-testid="page" data-page={tab}>
                  <input aria-label="Draft" defaultValue="unsent draft" />
                  <div contentEditable suppressContentEditableWarning data-testid="editor">draft</div>
                </div>
              </AppLayout>
            </LocaleProvider>
          );
        }
        const root = createRoot(container);
        act(() => root.render(<Harness />));
        return {
          navigate(tab) { act(() => navigate(tab)); },
          unmount() { act(() => root.unmount()); },
        };
      }
    `,
    resolveDir: desktopDir,
    sourcefile: 'harness.tsx',
    loader: 'tsx',
  },
  outfile: outputPath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  jsx: 'automatic',
  logLevel: 'silent',
  plugins: [{
    name: 'layout-harness',
    setup(builder) {
      // Only native window/updater services and animation are stubbed. The
      // layout, navigation buttons, state provider and Radix popover are real.
      builder.onResolve({ filter: /MacFullscreenWindowControls$|GlobalUpdateIndicator$|gsapMotion$/ }, (args) => ({
        path: args.path,
        namespace: 'native-stub',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'native-stub' }, () => ({
        loader: 'js',
        contents: `
          export function MacFullscreenWindowControls() { return null; }
          export function GlobalUpdateIndicator() { return null; }
          export function useGSAP() {}
          export function shouldReduceMotion() { return true; }
          export const gsap = { set() {}, to() {} };
          export const ccemMotion = {};
        `,
      }));
      builder.onResolve({ filter: /^@\// }, async (args) => {
        const base = path.join(desktopDir, 'src', args.path.slice(2));
        for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
          const candidate = `${base}${suffix}`;
          if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) {
            return { path: candidate };
          }
        }
        return { errors: [{ text: `Unresolved desktop import: ${args.path}` }] };
      });
    },
  }],
});
const { mount, act } = await import(pathToFileURL(outputPath).href);

const query = (selector) => document.querySelector(selector);
const menu = () => query('[data-testid="workspace-navigation-menu"]');
const trigger = () => query('[data-testid="workspace-navigation-trigger"]');
const shell = () => query('[data-sidebar-mode]');
const sidebar = () => query('[data-sidebar="sidebar"]');
const page = () => query('[data-testid="page"]').dataset.page;

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
async function click(element) {
  assert.ok(element, 'click target exists');
  act(() => element.click());
  await settle();
}
async function press(key, options = {}, target = document.activeElement || document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  act(() => target.dispatchEvent(event));
  await settle();
  return event;
}
async function start(t, preference = 'expanded') {
  localStorage.clear();
  localStorage.setItem('ccem-sidebar-state', preference);
  const mounted = mount(query('#root'));
  await settle();
  t.after(async () => {
    mounted.unmount();
    await settle();
  });
  return mounted;
}

test.after(async () => {
  stopEsbuild();
  dom.window.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('workspace omits the permanent global sidebar even with the legacy expanded preference', async (t) => {
  await start(t);
  assert.equal(sidebar(), null, 'global navigation does not occupy a second column');
  assert.equal(menu(), null);
  assert.equal(shell().style.getPropertyValue('--ccem-sidebar-shell-width'), '0px');
  const draft = query('input');
  draft.value = 'keep my current draft';

  await click(trigger());
  assert.ok(menu());
  assert.equal(trigger().getAttribute('aria-expanded'), 'true');
  assert.equal(menu().querySelectorAll('[data-sidebar-nav-item]').length, 10);
  assert.equal(shell().style.getPropertyValue('--ccem-sidebar-shell-width'), '0px');
  await press('Escape');
  assert.equal(menu(), null);
  assert.equal(document.activeElement, trigger(), 'Escape returns focus to the opener');
  assert.equal(query('input'), draft, 'opening navigation does not remount the workspace');
  assert.equal(draft.value, 'keep my current draft');
  assert.equal(localStorage.getItem('ccem-sidebar-state'), 'expanded');
});

test('menu navigation restores normal pages and returning to workspace always dismisses the menu', async (t) => {
  const mounted = await start(t);
  await click(trigger());
  await click(query('[data-testid="nav-environments"]'));
  assert.equal(page(), 'environments');
  assert.equal(menu(), null);
  assert.equal(sidebar().style.width, '208px');
  await click(query('[data-testid="nav-workspace"]'));
  assert.equal(page(), 'workspace');
  assert.equal(menu(), null);
  assert.equal(sidebar(), null);

  await click(trigger());
  mounted.navigate('history'); // The same route change can also come from a global shortcut.
  await settle();
  assert.equal(menu(), null);
  mounted.navigate('workspace');
  await settle();
  assert.equal(menu(), null, 'a shortcut departure cannot leave a stale menu open on return');
  assert.equal(localStorage.getItem('ccem-sidebar-state'), 'expanded');
});

test('floating navigation keeps the collapsed preference and normal sidebar toggles still persist', async (t) => {
  await start(t, 'collapsed');
  await click(trigger());
  await click(query('[data-testid="nav-history"]'));
  assert.equal(sidebar().style.width, '0px');
  await click(query('[data-sidebar="trigger"]'));
  assert.equal(sidebar().style.width, '208px');
  assert.equal(localStorage.getItem('ccem-sidebar-state'), 'expanded');
  await click(query('[data-sidebar="trigger"]'));
  await click(query('[data-testid="collapsed-workspace-shortcut"]'));
  assert.equal(page(), 'workspace');
  await click(trigger());
  await press('Escape');
  assert.equal(localStorage.getItem('ccem-sidebar-state'), 'collapsed');
});

test('Cmd/Ctrl+B toggles navigation without intercepting typing or changing saved layout', async (t) => {
  await start(t);
  act(() => document.body.focus());
  await press('b', { metaKey: true }, document.body);
  assert.ok(menu());
  await press('b', { metaKey: true });
  assert.equal(menu(), null);
  await press('b', { ctrlKey: true }, document.body);
  assert.ok(menu());
  await press('Escape');

  for (const editor of [query('input'), query('[contenteditable]')]) {
    // jsdom does not implement the browser's isContentEditable getter.
    if (editor.hasAttribute('contenteditable')) {
      Object.defineProperty(editor, 'isContentEditable', { value: true });
    }
    act(() => editor.focus());
    const event = await press('b', { metaKey: true }, editor);
    assert.equal(event.defaultPrevented, false);
    assert.equal(menu(), null);
  }
  assert.equal(localStorage.getItem('ccem-sidebar-state'), 'expanded');
});

test('clicking outside dismisses navigation and leaves workspace content interactive', async (t) => {
  await start(t);
  await click(trigger());
  const draft = query('input');
  act(() => {
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    draft.dispatchEvent(event);
    draft.focus();
  });
  await settle();
  assert.equal(menu(), null);
  assert.equal(document.activeElement, draft);
  assert.equal(page(), 'workspace');
  await click(trigger());
  await click(query('[data-testid="nav-workspace"]'));
  assert.equal(menu(), null, 'selecting the current page also closes the menu');
});
