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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-prompt-ime-enter-'));
  const outfile = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { PromptArea } from './src/components/prompt-area';

        export function mount(container) {
          const submits = [];
          function Harness() {
            const [segments, setSegments] = useState([]);
            return <PromptArea value={segments} onChange={setSegments}
              onSubmit={(value) => submits.push(value)} markdown={false} />;
          }
          const root = createRoot(container);
          act(() => root.render(<Harness />));
          const editor = container.querySelector('[contenteditable]');
          return {
            editor,
            submits,
            act,
            unmount() { act(() => root.unmount()); },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'prompt-ime-enter-harness.tsx',
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
  expose('requestAnimationFrame', () => 0);
  expose('cancelAnimationFrame', () => {});
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container: window.document.getElementById('root'),
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

async function setup(t) {
  const dom = installDom();
  const harness = await (harnessPromise ??= importHarness());
  const mounted = harness.mount(dom.container);
  t.after(() => { mounted.unmount(); dom.restore(); });
  mounted.act(() => mounted.editor.focus());
  return mounted;
}

function keydown(mounted, { key, keyCode, isComposing = false }) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing });
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  mounted.act(() => mounted.editor.dispatchEvent(event));
  return event;
}

function compose(mounted, text) {
  mounted.act(() => {
    mounted.editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    mounted.editor.textContent = text;
    mounted.editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: text }));
    mounted.editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('WebKit IME commit Enter (compositionend first, keyCode 229) never submits, even after the cooldown', async (t) => {
  const mounted = await setup(t);
  compose(mounted, '你好');
  // A busy main thread can push the IME keydown past the 100ms cooldown.
  await wait(150);
  const event = keydown(mounted, { key: 'Enter', keyCode: 229 });
  assert.equal(mounted.submits.length, 0);
  assert.equal(event.defaultPrevented, false, 'the IME keeps ownership of its own Enter');
});

test('Enter reported as composing never submits', async (t) => {
  const mounted = await setup(t);
  keydown(mounted, { key: 'Enter', keyCode: 13, isComposing: true });
  assert.equal(mounted.submits.length, 0);
});

test('a real Enter after the IME commit still submits', async (t) => {
  const mounted = await setup(t);
  compose(mounted, '你好');
  await wait(150);
  keydown(mounted, { key: 'Enter', keyCode: 229 });
  const event = keydown(mounted, { key: 'Enter', keyCode: 13 });
  assert.equal(mounted.submits.length, 1);
  assert.equal(event.defaultPrevented, true);
});
