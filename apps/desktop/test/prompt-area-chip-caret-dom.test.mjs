import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const desktopDir = path.resolve(import.meta.dirname, '..');
let importedHarnessPromise;

test.after(async () => {
  if (importedHarnessPromise) {
    const importedHarness = await importedHarnessPromise;
    await fs.rm(importedHarness.tempDir, { recursive: true, force: true });
  }
  stopEsbuild();
});

async function resolveDesktopSource(importPath) {
  const base = path.join(desktopDir, 'src', importPath.slice(2));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next source shape.
    }
  }
  return null;
}

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-prompt-area-chip-caret-'));
  const outputPath = path.join(tempDir, 'harness.cjs');

  try {
    await build({
      stdin: {
        contents: `
        import React, { act, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { PromptArea } from '@/components/prompt-area';

        let latestValue = [];
        let triggerPanelOpen = false;
        const triggers = [{
          char: '/',
          position: 'any',
          mode: 'dropdown',
          emptyMessage: 'no match',
          onSearch: async () => [],
        }];

        function ControlledPromptArea({ initialValue }) {
          const [value, setValue] = useState(initialValue);
          latestValue = value;
          return (
            <PromptArea
              value={value}
              onChange={(nextValue) => { latestValue = nextValue; setValue(nextValue); }}
              triggers={triggers}
              onTriggerPanelChange={(state) => { triggerPanelOpen = state !== null; }}
              markdown={false}
              data-test-id="composer-editor"
            />
          );
        }

        function setCaret(node, offset) {
          const range = document.createRange();
          range.setStart(node, offset);
          range.collapse(true);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }

        function input(editor, inputType, data = null) {
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data, isComposing: false }));
        }

        export function mount(container, initialValue) {
          triggerPanelOpen = false;
          const root = createRoot(container);
          act(() => { root.render(<ControlledPromptArea initialValue={initialValue} />); });
          const editor = container.querySelector('[data-test-id="composer-editor"]');
          if (!editor) throw new Error('prompt area editor did not mount');
          return {
            editor,
            getPlainText() {
              return latestValue
                .map((segment) => segment.type === 'text' ? segment.text : segment.trigger + segment.displayText)
                .join('');
            },
            isTriggerPanelOpen() { return triggerPanelOpen; },
            // Backspace the text that follows the last chip, leaving the chip as the last node.
            deleteTextAfterLastChip() {
              act(() => {
                editor.focus();
                while (editor.lastChild && editor.lastChild.dataset?.chipTrigger === undefined) {
                  editor.removeChild(editor.lastChild);
                }
                setCaret(editor, editor.childNodes.length);
                input(editor, 'deleteContentBackward');
              });
            },
            // WebKit inserts typed text at the caret, which now lives inside the sentinel.
            typeIntoSentinel(text) {
              const sentinel = editor.querySelector('[data-sentinel="true"]');
              if (!sentinel) throw new Error('trailing chip sentinel is missing');
              act(() => {
                sentinel.firstChild.textContent = '\\u200B' + text;
                setCaret(sentinel.firstChild, sentinel.firstChild.textContent.length);
                input(editor, 'insertText', text);
              });
            },
            // WebKit's Cmd+Delete on the only line can leave a placeholder <br>
            // in the emptied editor instead of removing every child.
            deleteLineLeavingPlaceholderBr() {
              act(() => {
                editor.focus();
                while (editor.firstChild) editor.removeChild(editor.firstChild);
                editor.appendChild(document.createElement('br'));
                setCaret(editor, 0);
                input(editor, 'deleteSoftLineBackward');
              });
            },
            placeCaretAtEnd() {
              act(() => {
                editor.focus();
                setCaret(editor, editor.childNodes.length);
              });
            },
            pressShiftEnter() {
              act(() => {
                editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
              });
            },
            placeCaretAtStartOfTextAfterFirstChip() {
              act(() => {
                editor.focus();
                const chip = editor.querySelector('[data-chip-trigger]');
                setCaret(chip.nextSibling, 0);
              });
            },
            pressKey(key) {
              act(() => {
                editor.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
              });
            },
            unmount() { act(() => root.unmount()); },
          };
        }

        `,
        resolveDir: desktopDir,
        sourcefile: 'prompt-area-chip-caret-harness.tsx',
        loader: 'tsx',
      },
      outfile: outputPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      jsx: 'automatic',
      loader: {
        '.png': 'dataurl',
      },
      plugins: [{
        name: 'desktop-alias',
        setup(builder) {
          builder.onResolve({ filter: /^@\// }, async (args) => {
            const resolved = await resolveDesktopSource(args.path);
            return resolved
              ? { path: resolved }
              : { errors: [{ text: `Cannot resolve ${args.path}` }] };
          });
        },
      }],
      define: {
        'process.env.NODE_ENV': '"test"',
      },
      logLevel: 'silent',
    });

    return {
      harness: await import(pathToFileURL(outputPath).href),
      tempDir,
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function getImportedHarness() {
  importedHarnessPromise ??= importHarness();
  return importedHarnessPromise;
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const { window } = dom;
  const previous = new Map();

  const expose = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };

  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('IS_REACT_ACT_ENVIRONMENT', true);

  for (const name of [
    'Node',
    'Text',
    'Element',
    'HTMLElement',
    'HTMLBRElement',
    'HTMLAnchorElement',
    'Event',
    'InputEvent',
    'CompositionEvent',
    'KeyboardEvent',
    'MouseEvent',
    'MutationObserver',
    'DOMRect',
    'Range',
  ]) {
    expose(name, window[name]);
  }

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  let nextAnimationFrameHandle = 1;
  const animationFrames = new Map();
  const requestAnimationFrame = (callback) => {
    const handle = nextAnimationFrameHandle++;
    animationFrames.set(handle, callback);
    return handle;
  };
  const cancelAnimationFrame = (handle) => {
    animationFrames.delete(handle);
  };
  const flushAnimationFrames = () => {
    while (animationFrames.size > 0) {
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      for (const callback of callbacks) {
        callback(Date.now());
      }
    }
  };

  expose('ResizeObserver', ResizeObserver);
  expose('requestAnimationFrame', requestAnimationFrame);
  expose('cancelAnimationFrame', cancelAnimationFrame);
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserver,
  });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: requestAnimationFrame,
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: cancelAnimationFrame,
  });
  Object.defineProperty(window, '__flushAnimationFrames', {
    configurable: true,
    value: flushAnimationFrames,
  });

  return {
    container: window.document.getElementById('root'),
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete globalThis[name];
        }
      }
    },
  };
}

const commandChip = {
  type: 'chip',
  trigger: '/',
  value: '/repo/.claude/commands/dev-desktop.md',
  displayText: 'dev-desktop',
  data: { kind: 'command' },
};

test('caret stays drawable after deleting the text that follows a trailing chip', async (t) => {
  const { container, restore } = installDom();
  let promptArea;
  t.after(() => {
    promptArea?.unmount();
    restore();
  });

  const importedHarness = await getImportedHarness();
  promptArea = importedHarness.harness.mount(container, [
    { type: 'text', text: '先看 ' },
    commandChip,
    { type: 'text', text: ' ' },
  ]);

  promptArea.deleteTextAfterLastChip();

  assert.equal(promptArea.getPlainText(), '先看 /dev-desktop');
  const sentinel = promptArea.editor.querySelector('[data-sentinel="true"]');
  assert.ok(sentinel, 'a trailing chip needs a text anchor so WebKit can draw the caret after it');
  assert.ok(promptArea.editor.lastChild === sentinel);
  const selection = window.getSelection();
  assert.ok(selection.anchorNode.parentNode === sentinel, 'caret must sit inside the sentinel, not at editor level');
  assert.equal(selection.anchorOffset, 1);
  assert.equal(promptArea.isTriggerPanelOpen(), false, 'a resolved chip must not reopen its trigger dropdown');
});

test('typing after a trailing chip becomes plain text with the caret after it', async (t) => {
  const { container, restore } = installDom();
  let promptArea;
  t.after(() => {
    promptArea?.unmount();
    restore();
  });

  const importedHarness = await getImportedHarness();
  promptArea = importedHarness.harness.mount(container, [
    { type: 'text', text: '先看 ' },
    commandChip,
    { type: 'text', text: ' ' },
  ]);

  promptArea.deleteTextAfterLastChip();
  promptArea.typeIntoSentinel('跑一下');

  assert.equal(promptArea.getPlainText(), '先看 /dev-desktop跑一下');
  assert.equal(promptArea.editor.querySelector('[data-sentinel="true"]'), null);
  assert.equal(promptArea.editor.lastChild.nodeType, Node.TEXT_NODE);
  assert.equal(promptArea.editor.lastChild.textContent, '跑一下');
  const selection = window.getSelection();
  assert.ok(selection.anchorNode === promptArea.editor.lastChild);
  assert.equal(selection.anchorOffset, '跑一下'.length);
  assert.equal(promptArea.isTriggerPanelOpen(), false, 'text typed after a chip is not a trigger query');
});

test('backspace from the trailing sentinel deletes the chip in one press', async (t) => {
  const { container, restore } = installDom();
  let promptArea;
  t.after(() => {
    promptArea?.unmount();
    restore();
  });

  const importedHarness = await getImportedHarness();
  promptArea = importedHarness.harness.mount(container, [
    { type: 'text', text: '先看 ' },
    commandChip,
    { type: 'text', text: ' ' },
  ]);

  promptArea.deleteTextAfterLastChip();
  promptArea.pressKey('Backspace');

  assert.equal(promptArea.getPlainText(), '先看 ');
  assert.equal(promptArea.editor.querySelector('[data-chip-trigger]'), null);
  assert.equal(promptArea.editor.querySelector('[data-sentinel="true"]'), null, 'no sentinel once the chip is gone');
  const selection = window.getSelection();
  assert.ok(selection.anchorNode === promptArea.editor.lastChild, 'caret returns to a drawable text position');
  assert.equal(selection.anchorOffset, '先看 '.length);
});

test('deleting a chip mid-text leaves the caret where the chip was', async (t) => {
  const { container, restore } = installDom();
  let promptArea;
  t.after(() => {
    promptArea?.unmount();
    restore();
  });

  const importedHarness = await getImportedHarness();
  promptArea = importedHarness.harness.mount(container, [
    { type: 'text', text: '先看 ' },
    commandChip,
    { type: 'text', text: ' 然后提交' },
  ]);

  promptArea.placeCaretAtStartOfTextAfterFirstChip();
  promptArea.pressKey('Backspace');

  assert.equal(promptArea.getPlainText(), '先看  然后提交');
  const selection = window.getSelection();
  assert.equal(selection.anchorNode.nodeType, Node.TEXT_NODE);
  const before = document.createRange();
  before.selectNodeContents(promptArea.editor);
  before.setEnd(selection.anchorNode, selection.anchorOffset);
  assert.equal(before.toString().length, '先看 '.length, 'caret must not jump forward by the deleted chip length');
});

test('arrow left from the trailing sentinel crosses the chip in one press', async (t) => {
  const { container, restore } = installDom();
  let promptArea;
  t.after(() => {
    promptArea?.unmount();
    restore();
  });

  const importedHarness = await getImportedHarness();
  promptArea = importedHarness.harness.mount(container, [
    { type: 'text', text: '先看 ' },
    commandChip,
    { type: 'text', text: ' ' },
  ]);

  promptArea.deleteTextAfterLastChip();
  promptArea.pressKey('ArrowLeft');

  const selection = window.getSelection();
  assert.ok(selection.anchorNode === promptArea.editor.firstChild, 'caret lands before the chip, not on the invisible anchor');
  assert.equal(selection.anchorOffset, '先看 '.length);
  assert.equal(promptArea.getPlainText(), '先看 /dev-desktop');
});

test('Cmd+Delete leaving a WebKit placeholder <br> keeps the caret on the first line', async (t) => {
  const { container, restore } = installDom();
  let promptArea;
  t.after(() => {
    promptArea?.unmount();
    restore();
  });

  const importedHarness = await getImportedHarness();
  promptArea = importedHarness.harness.mount(container, [{ type: 'text', text: 'hello' }]);

  promptArea.deleteLineLeavingPlaceholderBr();

  assert.equal(promptArea.getPlainText(), '', 'an emptied editor must not become a newline');
  assert.equal(promptArea.editor.querySelector('[data-sentinel="true"]'), null, 'no second-line caret anchor');
  assert.equal(promptArea.editor.querySelector('br'), null);
});

test('Shift+Enter in an empty editor still inserts a real newline', async (t) => {
  const { container, restore } = installDom();
  let promptArea;
  t.after(() => {
    promptArea?.unmount();
    restore();
  });

  const importedHarness = await getImportedHarness();
  promptArea = importedHarness.harness.mount(container, []);

  promptArea.placeCaretAtEnd();
  promptArea.pressShiftEnter();

  assert.equal(promptArea.getPlainText(), '\n');
  assert.ok(promptArea.editor.querySelector('br'));
  assert.ok(promptArea.editor.querySelector('[data-sentinel="true"]'), 'a typed trailing newline keeps its caret anchor');
});
