import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';

const desktopDir = path.resolve(import.meta.dirname, '..');
let harnessPromise;

test.after(async () => {
  if (harnessPromise) {
    const harness = await harnessPromise;
    await fs.rm(harness.tempDir, { recursive: true, force: true });
  }
  stopEsbuild();
});

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-prompt-autogrow-'));
  const outfile = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { PromptArea } from './src/components/prompt-area';

        export function mount(container, options = {}) {
          let updateValue;
          let updateMaxHeight;
          let handle;
          let value;
          function Harness() {
            const [segments, setSegments] = useState([]);
            const [maxHeight, setMaxHeight] = useState(options.maxHeight ?? 260);
            const editorRef = useRef(null);
            value = segments;
            updateValue = setSegments;
            updateMaxHeight = setMaxHeight;
            handle = editorRef;
            return <PromptArea ref={editorRef} value={segments} onChange={setSegments}
              minHeight={72} maxHeight={maxHeight}
              autoGrow markdown={false} />;
          }
          const root = createRoot(container);
          act(() => root.render(<Harness />));
          const editor = container.querySelector('[contenteditable]');
          return {
            editor,
            value() { return value; },
            focus() { act(() => editor.focus()); },
            input(text, inputType = 'insertText') {
              act(() => {
                editor.textContent = text;
                editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: text }));
              });
            },
            setValue(segments) { act(() => updateValue(segments)); },
            setMaxHeight(height) { act(() => updateMaxHeight(height)); },
            clear() { act(() => handle.current.clear()); },
            compose(type) {
              act(() => editor.dispatchEvent(new CompositionEvent(type, { bubbles: true })));
            },
            async blur() {
              await act(async () => {
                editor.blur();
                await new Promise((resolve) => setTimeout(resolve, 170));
              });
            },
            flushFrame(callback) { act(callback); },
            unmount() { act(() => root.unmount()); },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'prompt-autogrow-harness.tsx',
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    alias: { '@': path.join(desktopDir, 'src') },
    logLevel: 'silent',
  });
  return { ...await import(pathToFileURL(outfile).href), tempDir };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const { window } = dom;
  const previous = new Map();
  const expose = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const name of ['Node', 'Text', 'Element', 'HTMLElement', 'HTMLBRElement',
    'HTMLAnchorElement', 'Event', 'InputEvent', 'CompositionEvent', 'KeyboardEvent',
    'MouseEvent', 'MutationObserver', 'DOMRect', 'Range']) {
    expose(name, window[name]);
  }
  expose('window', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  // React's bundled async act falls back to MessageChannel. Native Node ports
  // keep a test worker alive after completion, so use the repo's DOM shim.
  expose('MessageChannel', class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  });
  const frames = new Map();
  let frameId = 0;
  const scheduling = { requested: 0, cancelled: 0 };
  expose('requestAnimationFrame', (callback) => {
    scheduling.requested += 1;
    frames.set(++frameId, callback);
    return frameId;
  });
  expose('cancelAnimationFrame', (id) => {
    scheduling.cancelled += 1;
    frames.delete(id);
  });
  return {
    container: window.document.getElementById('root'),
    scheduling,
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

// JSDOM has no layout engine. Model the browser's scrollHeight floor and cap
// explicitly, while driving the real component and counting its DOM reads and
// writes. Native wrapping and selection are covered by the desktop smoke.
function modelLayout(editor) {
  const layout = { naturalHeight: 26, reads: 0, writes: [] };
  const heightProperty = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor.style), 'height');
  Object.defineProperty(editor.style, 'height', {
    configurable: true,
    get() { return heightProperty.get.call(this); },
    set(value) {
      layout.writes.push(value);
      heightProperty.set.call(this, value);
    },
  });
  const clientHeight = () => Math.max(72, Math.min(Number.parseFloat(editor.style.maxHeight),
    Number.parseFloat(editor.style.height) || layout.naturalHeight));
  Object.defineProperty(editor, 'scrollHeight', {
    get() {
      layout.reads += 1;
      return Math.ceil(Math.max(clientHeight(), layout.naturalHeight));
    },
  });
  Object.defineProperty(editor, 'clientHeight', { get: () => Math.floor(clientHeight()) });
  return layout;
}

async function setup(t, options = {}) {
  const dom = installDom();
  const harness = await (harnessPromise ??= importHarness());
  const mounted = harness.mount(dom.container, options);
  const layout = modelLayout(mounted.editor);
  const flush = () => mounted.flushFrame(() => dom.flush());
  t.after(() => { mounted.unmount(); dom.restore(); });
  mounted.focus();
  flush();
  layout.writes.length = 0;
  layout.reads = 0;
  dom.scheduling.requested = 0;
  dom.scheduling.cancelled = 0;
  return { dom, mounted, layout, flush };
}

test('100 edits inside the minimum height perform no height writes or cancelled frames', async (t) => {
  const { dom, mounted, layout, flush } = await setup(t);
  for (let index = 0; index < 100; index += 1) {
    mounted.input(`draft ${index}`);
    flush();
  }
  assert.equal(mounted.editor.style.height, '72px');
  assert.deepEqual(mounted.value(), [{ type: 'text', text: 'draft 99' }]);
  assert.equal(layout.reads, 100, 'one read per input frame; no read after a height reset');
  assert.deepEqual(layout.writes, [], 'stable short drafts do not invalidate layout');
  assert.equal(dom.scheduling.requested, 100, 'input and value effect share one pending frame');
  assert.equal(dom.scheduling.cancelled, 0);
});

test('wrapping and deletion still grow and shrink between the minimum and maximum', async (t) => {
  const { mounted, layout, flush } = await setup(t);
  layout.naturalHeight = 104;
  mounted.input('wrapped draft');
  flush();
  assert.equal(mounted.editor.style.height, '104px');
  layout.naturalHeight = 78;
  mounted.input('shorter draft', 'deleteContentBackward');
  flush();
  assert.equal(mounted.editor.style.height, '78px');
  layout.naturalHeight = 26;
  mounted.input('', 'deleteContentBackward');
  flush();
  assert.equal(mounted.editor.style.height, '72px');
  assert.equal(layout.writes.filter((height) => height === 'auto').length, 3);
});

test('long drafts keep the scroll cap without height writes, then shrink when content fits', async (t) => {
  const { mounted, layout, flush } = await setup(t);
  layout.naturalHeight = 520;
  mounted.input('long draft');
  flush();
  layout.writes.length = 0;
  for (let index = 0; index < 100; index += 1) {
    layout.naturalHeight = 520 + index;
    mounted.input(`long draft ${index}`);
    flush();
  }
  assert.deepEqual(layout.writes, []);
  assert.equal(mounted.editor.clientHeight, 260);
  assert.equal(mounted.editor.style.overflowY, 'auto');
  layout.naturalHeight = 208;
  mounted.input('fits again', 'deleteContentBackward');
  flush();
  assert.equal(mounted.editor.style.height, '208px');
});

test('a fractional max-height cannot hide content shrinking below the cap', async (t) => {
  const { mounted, layout, flush } = await setup(t, { maxHeight: 260.5 });
  layout.naturalHeight = 520;
  mounted.input('long draft');
  flush();
  layout.naturalHeight = 104;
  mounted.input('short draft', 'deleteContentBackward');
  flush();
  assert.equal(mounted.editor.style.height, '104px');
});

test('coalesced frames use updated size limits when props change before measurement', async (t) => {
  const { mounted, layout, flush } = await setup(t);
  layout.naturalHeight = 312;
  mounted.input('long draft');
  flush();
  layout.naturalHeight = 416;
  mounted.input('longer draft');
  mounted.setMaxHeight(520);
  flush();
  assert.equal(mounted.editor.style.height, '416px');
  assert.equal(mounted.editor.clientHeight, 416);
});

test('composition defers measurement until commit without losing the final text', async (t) => {
  const { mounted, layout, flush } = await setup(t);
  mounted.compose('compositionstart');
  layout.naturalHeight = 104;
  mounted.input('输入中的中文', 'insertCompositionText');
  flush();
  assert.equal(layout.reads, 0);
  assert.deepEqual(layout.writes, []);
  mounted.compose('compositionend');
  flush();
  assert.equal(mounted.editor.style.height, '104px');
  assert.deepEqual(mounted.value(), [{ type: 'text', text: '输入中的中文' }]);
});

test('programmatic chip insertion, clear, blur collapse and refocus keep height behavior', async (t) => {
  const { mounted, layout, flush } = await setup(t);
  layout.naturalHeight = 104;
  mounted.setValue([{ type: 'text', text: 'files ' }, {
    type: 'chip', trigger: '@', value: 'src/index.ts', displayText: 'index.ts',
  }]);
  flush();
  assert.equal(mounted.editor.style.height, '104px');
  assert.equal(mounted.editor.querySelector('[data-chip-value]').dataset.chipValue, 'src/index.ts');
  await mounted.blur();
  assert.equal(mounted.editor.style.height, '72px');
  assert.equal(mounted.editor.style.overflowY, 'hidden');
  mounted.focus();
  flush();
  assert.equal(mounted.editor.style.height, '104px');
  layout.naturalHeight = 26;
  mounted.clear();
  flush();
  assert.equal(mounted.editor.style.height, '72px');
  assert.deepEqual(mounted.value(), []);
});
