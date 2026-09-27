import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
function compile(source) {
  return ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
}
const source = await fs.readFile(new URL('../src/lib/nativeBrowserOverlayManager.ts', import.meta.url), 'utf8');
const api = {};
new Function('exports', compile(source))(api);

function setup(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  });
  const view = dom.window;
  const frames = new Map();
  let frameId = 0;
  let now = 0;
  view.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
  view.cancelAnimationFrame = (id) => frames.delete(id);
  Object.defineProperty(view.performance, 'now', { value: () => now });
  const resizes = [];
  view.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.elements = new Set(); resizes.push(this); }
    observe(element) { this.elements.add(element); }
    unobserve(element) { this.elements.delete(element); }
    disconnect() { this.elements.clear(); }
  };
  const sent = [];
  let zoom = 1;
  let modal = false;
  const manager = api.createNativeBrowserOverlayManager({
    document: view.document,
    readZoom: () => zoom,
    isModal: () => modal,
    send: async (state) => { sent.push(state); await options.send?.(state); },
    onError: options.onError,
  });
  t.after(() => { manager.dispose(); dom.window.close(); });
  return {
    dom, view, manager, sent, resizes, frames,
    setZoom(value) { zoom = value; },
    setModal(value) { modal = value; },
    frame() {
      now += 20;
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(now); }
    },
    element(rect = [10, 20, 120, 80], attributes = {}) {
      const element = view.document.createElement('div');
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      let currentRect = new view.DOMRect(...rect);
      element.getBoundingClientRect = () => currentRect;
      element.move = (next) => { currentRect = new view.DOMRect(...next); };
      view.document.body.append(element);
      return element;
    },
  };
}

test('overlay registration is idempotent across overlapping owners and unmount cleanup', (t) => {
  const h = setup(t);
  const element = h.element();
  const first = h.manager.register(element);
  const second = h.manager.register(element);
  h.manager.flush();
  assert.equal(h.sent.at(-1).regions.length, 1);
  first(); first();
  h.manager.flush();
  assert.equal(h.sent.at(-1).regions.length, 1);
  second();
  h.manager.flush();
  assert.deepEqual(h.sent.at(-1).regions, []);
  assert.equal(h.resizes[0].elements.has(element), false);
});

test('a newly mounted overlay publishes in the commit microtask before animation frames', async (t) => {
  const h = setup(t);
  h.manager.register(h.element());
  assert.equal(h.sent.length, 0);
  await Promise.resolve();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].regions.length, 1);
});

test('modal ACK fences an older delayed unlock before the surface occlude transaction can run', async (t) => {
  const pending = [];
  let nativeRevision = 0;
  let nativeModal = false;
  let surfaceOccluded = false;
  const h = setup(t, { send: (snapshot) => new Promise((resolve) => {
    pending.push(() => {
      if (snapshot.revision > nativeRevision) {
        nativeRevision = snapshot.revision;
        nativeModal = snapshot.modal;
        if (!nativeModal) surfaceOccluded = false;
      }
      resolve();
    });
  }) });
  h.manager.flush(); // The old modal=false IPC is still in flight.
  h.setModal(true);
  let released = false;
  const barrier = h.manager.waitForModalSync().then(() => {
    released = true;
    surfaceOccluded = true; // Equivalent ordering to BrowserPanel's occlude IPC.
  });
  await Promise.resolve();
  assert.equal(released, false, 'occlude must not race the newer geometry ACK');
  assert.equal(pending.length, 2);
  pending[1]();
  await barrier;
  assert.equal(nativeModal, true);
  assert.equal(surfaceOccluded, true);
  pending[0]();
  await Promise.resolve();
  assert.equal(nativeModal, true, 'the earlier false revision is stale at native delivery');
  assert.equal(surfaceOccluded, true, 'late unlock cannot clear the acknowledged occlusion');
});

test('modal geometry rejection keeps the barrier closed and is handled for fire-and-forget observers', async (t) => {
  const errors = [];
  const h = setup(t, {
    send: async () => { throw new Error('geometry rejected'); },
    onError: (error) => errors.push(error.message),
  });
  h.setModal(true);
  h.manager.flush();
  await assert.rejects(h.manager.waitForModalSync(), /geometry rejected/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['geometry rejected']);
});

test('a failed unchanged snapshot retries with capped backoff until the live viewport can recover', async (t) => {
  let broken = true;
  const errors = [];
  const h = setup(t, {
    send: async () => { if (broken) throw Error('bridge unavailable'); },
    onError: (error) => errors.push(error.message),
  });
  const timers = new Map();
  let timerId = 0;
  h.view.setTimeout = (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; };
  h.view.clearTimeout = (id) => timers.delete(id);
  h.manager.register(h.element([400, 100, 500, 600]), 'viewport');
  h.manager.register(h.element());
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  await settle();
  const delays = [];
  for (let i = 0; i < 7; i++) {
    assert.equal(timers.size, 1);
    const [id, { fn, delay }] = [...timers][0];
    timers.delete(id);
    delays.push(delay);
    fn();
    await settle();
  }
  assert.deepEqual(delays, [100, 200, 400, 800, 1600, 2000, 2000]);
  assert.equal(errors.length, 8);
  broken = false;
  const [id, { fn }] = [...timers][0];
  timers.delete(id);
  fn();
  await settle();
  assert.equal(timers.size, 0);
  assert.equal(h.sent.length, 9);
  assert.ok(h.sent.every((state) => state.regions.length === 1));
  h.manager.flush();
  assert.equal(h.sent.length, 9, 'successful steady state has no keepalive polling');
});

test('regions follow live geometry and acknowledged zoom without devicePixelRatio', (t) => {
  const h = setup(t);
  Object.defineProperty(h.view, 'devicePixelRatio', { value: 2 });
  const element = h.element([100, 50, 120, 60]);
  h.manager.register(element);
  h.setZoom(0.8);
  h.manager.flush();
  assert.deepEqual(h.sent.at(-1).regions, [{ x: 80, y: 40, width: 96, height: 48 }]);
  element.move([120, 55, 160, 100]);
  h.resizes[0].callback([]);
  h.frame();
  assert.deepEqual(h.sent.at(-1).regions, [{ x: 96, y: 44, width: 128, height: 80 }]);
  h.setZoom(1.2);
  h.view.dispatchEvent(new h.view.Event('ccem-zoom-change'));
  h.frame();
  assert.deepEqual(h.sent.at(-1).regions, [{ x: 144, y: 66, width: 192, height: 120 }]);
  assert.ok(h.sent.every((state, index) => state.revision === index + 1));
});

test('hidden and removed overlays never leave phantom input regions', async (t) => {
  const h = setup(t);
  const element = h.element();
  const release = h.manager.register(element);
  h.manager.flush();
  element.style.display = 'none';
  h.manager.flush();
  assert.deepEqual(h.sent.at(-1).regions, []);
  element.style.display = '';
  element.remove();
  h.manager.flush();
  assert.deepEqual(h.sent.at(-1).regions, []);
  release();
});

test('Sonner and explicit custom overlays are discovered and retired incrementally', async (t) => {
  const h = setup(t);
  const toast = h.element([500, 100, 240, 70], { 'data-sonner-toast': '' });
  const custom = h.element([420, 250, 300, 120], { 'data-ccem-native-overlay': '' });
  await Promise.resolve();
  h.manager.flush();
  assert.equal(h.sent.at(-1).regions.length, 2);
  toast.remove();
  custom.removeAttribute('data-ccem-native-overlay');
  await Promise.resolve();
  h.manager.flush();
  assert.deepEqual(h.sent.at(-1).regions, []);
});

test('store barriers and Radix body modal state independently block CEF input', async (t) => {
  const h = setup(t);
  h.setModal(true);
  h.manager.flush();
  assert.equal(h.sent.at(-1).modal, true);
  h.view.document.body.style.pointerEvents = 'none';
  h.setModal(false);
  h.manager.flush();
  assert.equal(h.sent.at(-1).modal, true);
  h.view.document.body.style.pointerEvents = '';
  await Promise.resolve();
  assert.equal(h.sent.at(-1).modal, false, 'body mutation publishes without waiting for RAF');
});

test('too many regions fail closed instead of exposing the unreported tail', (t) => {
  const h = setup(t);
  for (let index = 0; index < 257; index++) h.manager.register(h.element());
  h.manager.flush();
  assert.equal(h.sent.at(-1).modal, true);
  assert.deepEqual(h.sent.at(-1).regions, []);
});

test('only decorative backgrounds are clipped and viewport release fills their hole', (t) => {
  const h = setup(t);
  const backdrop = h.element([40, 30, 900, 650]);
  const viewport = h.element([500, 160, 400, 480]);
  h.manager.register(backdrop, 'backdrop');
  const closeViewport = h.manager.register(viewport, 'viewport');
  h.setZoom(0.8);
  h.manager.flush();
  const clip = backdrop.style.getPropertyValue('--ccem-browser-backdrop-clip');
  assert.match(clip, /polygon\(evenodd,/);
  assert.match(clip, /460px 130px/);
  assert.match(clip, /860px 610px/);
  assert.equal(backdrop.style.clipPath, '');
  assert.equal(h.view.document.querySelector('main').style.clipPath, '');
  assert.equal(h.view.document.documentElement.dataset.nativeBrowserHole, 'true');
  closeViewport();
  h.manager.flush();
  assert.equal(backdrop.style.getPropertyValue('--ccem-browser-backdrop-clip'), 'none');
  assert.equal(h.view.document.documentElement.dataset.nativeBrowserHole, 'false');
});

test('CEF pointer input emits outside events only at the current uncovered viewport', (t) => {
  const h = setup(t);
  const viewport = h.element([400, 100, 500, 600]);
  h.manager.register(viewport, 'viewport');
  h.setZoom(0.8);
  const received = [];
  for (const kind of ['pointerdown', 'mousedown', 'click', 'contextmenu']) {
    viewport.addEventListener(kind, (event) => received.push([event.type, event.clientX, event.clientY, event.button]));
  }
  h.manager.pointerDown({ x: 400, y: 120, button: 2 });
  assert.deepEqual(received, [['pointerdown', 500, 150, 2], ['mousedown', 500, 150, 2]]);
  received.length = 0;
  h.setModal(true);
  h.manager.pointerDown({ x: 400, y: 120, button: 0 });
  h.setModal(false);
  h.manager.register(h.element([480, 120, 80, 80]));
  h.manager.pointerDown({ x: 400, y: 120, button: 0 });
  h.manager.pointerDown({ x: 10, y: 10, button: 0 });
  assert.deepEqual(received, [], 'modal, stale covered-point, and outside-window events are ignored');
});

test('motion sampling settles and does not leave a permanent RAF loop', (t) => {
  const h = setup(t);
  h.manager.register(h.element());
  for (let i = 0; i < 30; i++) h.frame();
  assert.equal(h.frames.size, 0);
  assert.equal(h.sent.length, 1, 'unchanged geometry is not repeatedly sent');
});

test('StrictMode ref registration survives effect replay and unmount retires it', async (t) => {
  const h = setup(t);
  const globals = new Map();
  for (const [key, value] of Object.entries({
    window: h.view, document: h.view.document, navigator: h.view.navigator,
    CSS: { supports: () => true }, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const runtime = {};
  const sent = [];
  const activeManagers = [];
  h.view.__TAURI_INTERNALS__ = {};
  const stubs = {
    react: React,
    '@tauri-apps/api/event': { listen: async () => () => {} },
    '@/hooks/useZoom': { readAppZoom: () => 1 },
    './webcontentRecovery': { invokeBrowserCommand: async (command, args) => {
      if (command === 'browser_overlay_initialize') return true;
      sent.push(args);
    } },
    './nativeSurfaceOcclusionStore': { nativeSurfaceOcclusionStore: { isOccluded: () => false, subscribe: () => () => {} } },
    './nativeBrowserOverlayManager': { createNativeBrowserOverlayManager(options) {
      const manager = api.createNativeBrowserOverlayManager(options); activeManagers.push(manager); return manager;
    } },
  };
  new Function('require', 'exports', compile(await fs.readFile(new URL('../src/lib/nativeBrowserOverlay.ts', import.meta.url), 'utf8')))(
    (name) => { assert.ok(stubs[name], name); return stubs[name]; }, runtime,
  );
  await runtime.initializeNativeBrowserOverlays();
  const container = h.view.document.querySelector('main');
  const root = createRoot(container);
  const forwarded = React.createRef();
  function Overlay() {
    const ref = runtime.useNativeBrowserOverlayRef(forwarded);
    return React.createElement('div', { ref, 'data-test-overlay': '' });
  }
  React.act(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Overlay))));
  forwarded.current.getBoundingClientRect = () => new h.view.DOMRect(20, 40, 100, 80);
  activeManagers[0].flush();
  assert.deepEqual(sent.at(-1).regions, [{ x: 20, y: 40, width: 100, height: 80 }]);
  React.act(() => root.unmount());
  activeManagers[0].flush();
  assert.deepEqual(sent.at(-1).regions, []);
  assert.equal(forwarded.current, null);
  h.view.dispatchEvent(new h.view.Event('pagehide'));
});

test('a CEF click dismisses a real non-modal Radix popover and leaves its viewport mounted', async (t) => {
  const h = setup(t);
  const globals = new Map();
  const values = {
    window: h.view, document: h.view.document, navigator: h.view.navigator,
    getComputedStyle: h.view.getComputedStyle.bind(h.view), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of ['HTMLElement', 'HTMLInputElement', 'Node', 'Element', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'Event', 'DOMRect']) {
    values[key] = h.view[key];
  }
  for (const [key, value] of Object.entries(values)) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const Popover = require('@radix-ui/react-popover');
  const viewport = h.element([400, 100, 500, 600]);
  h.manager.register(viewport, 'viewport');
  const container = h.view.document.querySelector('main');
  const root = createRoot(container);
  let releaseContent;
  const attach = (element) => {
    releaseContent?.();
    if (!element) return;
    element.getBoundingClientRect = () => new h.view.DOMRect(420, 120, 200, 120);
    releaseContent = h.manager.register(element);
  };
  const changes = [];
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return React.createElement(Popover.Root, { modal: false, open, onOpenChange(next) { changes.push(next); setOpen(next); } },
      React.createElement(Popover.Trigger, null, 'Review'),
      React.createElement(Popover.Portal, null, React.createElement(Popover.Content, {
        ref: attach, 'data-popover': '', onOpenAutoFocus(event) { event.preventDefault(); },
      }, 'Review content')),
    );
  }
  await React.act(async () => {
    root.render(React.createElement(Harness));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert.ok(h.view.document.querySelector('[data-popover]'));
  React.act(() => h.manager.pointerDown({ x: 700, y: 400, button: 0 }));
  assert.deepEqual(changes, [false]);
  assert.equal(h.view.document.querySelector('[data-popover]'), null);
  assert.equal(viewport.isConnected, true);
  React.act(() => root.unmount());
  // Radix restores focus in a deferred unmount event; keep this DOM's event
  // constructors installed until that cleanup has completed.
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
});
