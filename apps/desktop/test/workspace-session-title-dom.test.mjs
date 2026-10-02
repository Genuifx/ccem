import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(import.meta.dirname, '..');
const originalGlobals = new Map();
let dom, React, createRoot, gsap, WorkspaceSessionTitle;

test.before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ gsap } = require('gsap'));
  const motion = {};
  const compile = (source, jsx) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx, esModuleInterop: true },
  }).outputText;
  new Function('require', 'exports', compile(await fs.readFile(path.join(desktopDir, 'src/lib/gsapMotion.ts'), 'utf8')))(require, motion);
  const exports = {};
  const componentSource = await fs.readFile(path.join(desktopDir, 'src/components/workspace/WorkspaceSessionTitle.tsx'), 'utf8');
  new Function('require', 'exports', compile(componentSource, ts.JsxEmit.ReactJSX))((name) => {
    if (name === '@/lib/gsapMotion') return motion;
    if (name === '@/lib/utils') return { cn: (...values) => values.filter(Boolean).join(' ') };
    return require(name);
  }, exports);
  WorkspaceSessionTitle = exports.WorkspaceSessionTitle;
});

test.after(() => {
  gsap?.globalTimeline.clear();
  gsap?.ticker.sleep();
  dom?.window.close();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

async function mountTitle(t, { reduced = false, hidden = false } = {}) {
  dom.window.matchMedia = () => ({ matches: reduced });
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (title) => {
    await React.act(async () => root.render(React.createElement(WorkspaceSessionTitle, { title })));
    gsap.ticker.sleep();
  };
  const finish = () => {
    for (const animation of gsap.globalTimeline.getChildren(false, true, true)) animation.totalProgress(1);
    gsap.ticker.sleep();
  };
  const unmount = async () => { await React.act(async () => root.unmount()); container.remove(); };
  t.after(unmount);
  await render('原始用户请求');
  return { container, render, finish, unmount,
    current: container.querySelector('[data-title-current]'), outgoing: container.querySelector('[data-title-outgoing]') };
}

test('title is visible on first mount and unchanged rerenders do not animate', async (t) => {
  const view = await mountTitle(t);
  assert.equal(view.current.textContent, '原始用户请求');
  assert.equal(view.current.style.opacity, '');
  await view.render('原始用户请求');
  assert.equal(view.outgoing.textContent, '');
  assert.equal(gsap.getTweensOf(view.current).length, 0);
});

test('a generated title replaces the previous text with real GSAP opacity and translation', async (t) => {
  const view = await mountTitle(t);
  await view.render('生成的短标题');
  assert.equal(view.current.textContent, '生成的短标题');
  assert.equal(view.container.firstChild.getAttribute('aria-label'), '生成的短标题');
  assert.equal(view.outgoing.textContent, '原始用户请求');
  assert.equal(view.outgoing.getAttribute('aria-hidden'), 'true');
  assert.equal(view.current.style.opacity, '0', 'the first frame must not wait for a GSAP getter or ticker');
  assert.equal(Number(gsap.getProperty(view.current, 'opacity')), 0);
  assert.equal(Number(gsap.getProperty(view.current, 'y')), 5);
  view.finish();
  assert.equal(Number(gsap.getProperty(view.current, 'opacity')), 1);
  assert.equal(Number(gsap.getProperty(view.current, 'y')), 0);
  assert.equal(view.outgoing.textContent, '');
});

test('rapid title replacement cancels the old motion and settles on the latest title', async (t) => {
  const view = await mountTitle(t);
  await view.render('第一版标题');
  await view.render('最新手动标题');
  assert.equal(view.outgoing.textContent, '第一版标题');
  view.finish();
  assert.equal(view.current.textContent, '最新手动标题');
  assert.equal(view.outgoing.textContent, '');
  await view.unmount();
  assert.equal(gsap.getTweensOf(view.current).length, 0);
});

test('reduced motion replaces the title immediately without starting a tween', async (t) => {
  const view = await mountTitle(t, { reduced: true });
  await view.render('生成的短标题');
  assert.equal(view.current.textContent, '生成的短标题');
  assert.equal(view.current.style.opacity, '');
  assert.equal(view.outgoing.textContent, '');
  assert.equal(gsap.getTweensOf(view.current).length, 0);
});

test('a background window receives the new title immediately without queuing a later animation', async (t) => {
  const view = await mountTitle(t, { hidden: true });
  await view.render('生成的短标题');
  assert.equal(view.current.textContent, '生成的短标题');
  assert.equal(view.current.style.opacity, '');
  assert.equal(view.outgoing.textContent, '');
  assert.equal(gsap.getTweensOf(view.current).length, 0);
});
