import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(import.meta.dirname, '..');
const workspaceDir = 'components/workspace/';
const motionCases = [
  ['transcript', `${workspaceDir}WorkspaceTranscriptList.tsx`, 'listRef'],
  ['page', 'App.tsx', 'appPageMotionRef'],
  ['attention', `${workspaceDir}WorkspaceNativeSessionView.tsx`, 'attentionPanelRef'],
  ['composer attention', `${workspaceDir}WorkspaceSessionComposer.tsx`, 'composerShellRef', 0],
  ['attachments', `${workspaceDir}WorkspaceSessionComposer.tsx`, 'composerShellRef', 1],
  ['submit button', `${workspaceDir}WorkspaceSessionComposer.tsx`, 'composerShellRef', 2],
  ['tool detail', `${workspaceDir}WorkspaceMessageBubble.tsx`, 'detailBodyRef'],
  ['tool digest', `${workspaceDir}WorkspaceMessageBubble.tsx`, 'digestBodyRef'],
];

let dom;
let React;
let createRoot;
let gsap;
let useGSAP;
let motionHelpers;
const originalGlobals = new Map();

test.before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    // Advance the real GSAP timeline explicitly; no wall-clock/rAF race.
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ gsap } = require('gsap'));
  ({ useGSAP } = require('@gsap/react'));
  gsap.registerPlugin(useGSAP);

  const source = await fs.readFile(path.join(desktopDir, 'src/lib/gsapMotion.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  motionHelpers = {};
  new Function('require', 'exports', compiled)(require, motionHelpers);
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

async function loadEffect([, file, scope, index = 0]) {
  // Execute the current source effects/configuration with real React and GSAP;
  // the small DOM fixtures isolate animation ownership from IPC/data fetching.
  const source = await fs.readFile(path.join(desktopDir, 'src', file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useGSAP') {
      const config = node.arguments[1];
      const scopeProperty = config?.properties?.find((property) => property.name?.getText(ast) === 'scope');
      if (scopeProperty?.initializer?.getText(ast) === scope) effects.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(effects[index], `Missing executable motion effect in ${file}`);
  return ts.transpileModule(effects[index], {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

async function mountEffect(motionCase, { reduced = false, windowSize = Infinity } = {}) {
  const source = await loadEffect(motionCase);
  const container = document.createElement('div');
  document.body.append(container);
  dom.window.matchMedia = () => ({ matches: reduced });
  let context;
  let execute;

  function Harness({ count, revision = count, open = true, prefix = [], hidden = false }) {
    const rootRef = React.useRef(null);
    const previousMotionKeysRef = React.useRef([]);
    const hasHydratedMotionRef = React.useRef(false);
    const hasAnimatedAppPageRef = React.useRef(false);
    const previousAttachmentIdsRef = React.useRef([]);
    const displayItems = [...prefix, ...Array.from({ length: count }, (_, index) => `row-${index}`)]
      .map((key) => ({ key }));
    const attachments = displayItems.slice(-windowSize).map(({ key }) => ({ id: key }));
    const bindings = {
      ...motionHelpers,
      useGSAP(callback, config) {
        const result = useGSAP(callback, config);
        context = result.context;
        return result;
      },
      listRef: rootRef,
      appPageMotionRef: rootRef,
      attentionPanelRef: rootRef,
      composerShellRef: rootRef,
      attentionDockRef: rootRef,
      attachmentStripRef: rootRef,
      primaryActionButtonRef: rootRef,
      detailBodyRef: rootRef,
      digestBodyRef: rootRef,
      previousMotionKeysRef,
      hasHydratedMotionRef,
      hasAnimatedAppPageRef,
      previousAttachmentIdsRef,
      displayItems,
      displayItemTailSignal: `${displayItems.length}:${displayItems.at(-1)?.key}`,
      startupReady: true,
      activeTab: `page-${revision}`,
      attentionMotionKey: String(revision),
      attachments,
      attachmentMotionKey: attachments.map(({ id }) => id).join('|'),
      isDragTarget: revision % 2 === 0,
      resolvedActionLabel: String(revision),
      isSubmitting: revision % 2 === 0,
      open,
      hasRenderedBody: revision % 2 === 0,
    };
    execute ??= new Function(...Object.keys(bindings), source);
    execute(...Object.values(bindings));
    return React.createElement('div', { ref: rootRef, hidden },
      ...displayItems.slice(-windowSize).map(({ key }) => React.createElement('div', {
        key,
        'data-transcript-item-key': key,
        'data-native-attention-card': key,
        'data-composer-attachment-chip': true,
        'data-attachment-id': key,
      }, key)),
    );
  }

  const root = createRoot(container);
  const mounted = {
    container,
    render(props) {
      React.act(() => root.render(React.createElement(Harness, props)));
      gsap.ticker.sleep();
    },
    advance(progress) {
      for (const animation of gsap.globalTimeline.getChildren(false, true, true)) {
        animation.totalProgress(progress);
      }
      gsap.ticker.sleep();
    },
    retainedTargets() {
      return new Set(context.getTweens().flatMap((tween) => tween.targets()));
    },
    entryCount() { return context.data.length; },
    unmount() {
      React.act(() => root.unmount());
      assert.equal(context.data.length, 0, 'unmount releases the final animation context');
      container.remove();
    },
  };
  mounted.render({ count: 1 });
  return mounted;
}

function assertVisible(element) {
  const style = getComputedStyle(element);
  assert.notEqual(style.visibility, 'hidden');
  assert.notEqual(style.opacity, '0');
  assert.equal(element.style.transform, '', 'completed/interrupted entrance releases its transform');
}

for (const motionCase of motionCases) {
  for (const reduced of [false, true]) {
    test(`${motionCase[0]} releases completed and interrupted animations (reduced motion: ${reduced})`, async (t) => {
      const mounted = await mountEffect(motionCase, { reduced, windowSize: 1 });
      t.after(() => mounted.unmount());
      for (let count = 2; count <= 60; count++) {
        mounted.render({ count });
        mounted.advance(count % 2 ? 0.4 : 1);
        assert.ok(mounted.entryCount() <= 10, 'animation context remains bounded across repeated updates');
        for (const target of mounted.retainedTargets()) {
          assert.equal(target.isConnected, true, 'removed rows/attachments are not retained by animations');
        }
      }
      mounted.advance(1);
      for (const element of mounted.container.querySelectorAll('div')) assertVisible(element);
    });
  }
}

test('rapid transcript append restores interrupted rows and preserves history prepend / hidden return', async (t) => {
  const mounted = await mountEffect(motionCases[0]);
  t.after(() => mounted.unmount());
  mounted.render({ count: 2 });
  mounted.advance(0.3);
  const interruptedRow = mounted.container.querySelector('[data-transcript-item-key="row-1"]');
  mounted.render({ count: 3 });
  assertVisible(interruptedRow);
  mounted.advance(0.3);
  mounted.render({ count: 3, prefix: ['history'] });
  assert.equal(mounted.entryCount(), 0, 'prepending history clears the previous tail animation without animating recovered rows');
  for (const element of mounted.container.querySelectorAll('[data-transcript-item-key]')) assertVisible(element);

  mounted.render({ count: 4, prefix: ['history'], hidden: true });
  mounted.advance(1);
  mounted.render({ count: 4, prefix: ['history'] });
  assert.equal(mounted.container.firstChild.hidden, false);
  for (const element of mounted.container.querySelectorAll('[data-transcript-item-key]')) assertVisible(element);
});

for (const motionCase of motionCases.slice(-2)) {
  test(`${motionCase[0]} can close during entrance and reopen visibly`, async (t) => {
    const mounted = await mountEffect(motionCase);
    t.after(() => mounted.unmount());
    mounted.advance(0.3);
    mounted.render({ count: 1, revision: 2, open: false });
    assert.equal(mounted.entryCount(), 0, 'closing releases the interrupted entrance');
    assertVisible(mounted.container.firstChild);
    mounted.render({ count: 1, revision: 3, open: true });
    mounted.advance(1);
    assertVisible(mounted.container.firstChild);
  });
}
