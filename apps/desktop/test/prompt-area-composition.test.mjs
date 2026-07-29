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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-prompt-area-composition-'));
  const outputPath = path.join(tempDir, 'harness.cjs');

  try {
    await build({
      stdin: {
        contents: `
        import React, { act, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { PromptArea } from '@/components/prompt-area';

        let latestValue = [];
        let changeCount = 0;

        function ControlledPromptArea({ initialText, autoGrow }) {
          const [value, setValue] = useState([{ type: 'text', text: initialText }]);
          latestValue = value;

          return (
            <PromptArea
              value={value}
              onChange={(nextValue) => {
                latestValue = nextValue;
                changeCount += 1;
                setValue(nextValue);
              }}
              triggers={[]}
              markdown={false}
              data-test-id="composer-editor"
              autoGrow={autoGrow}
              minHeight={72}
              maxHeight={260}
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

        export function mount(container, initialText, options = {}) {
          changeCount = 0;
          const root = createRoot(container);
          act(() => {
            root.render(
              <ControlledPromptArea
                initialText={initialText}
                autoGrow={options.autoGrow ?? false}
              />,
            );
          });

          const editor = container.querySelector('[data-test-id="composer-editor"]');
          if (!editor) throw new Error('prompt area editor did not mount');
          let measuredHeight = 0;
          Object.defineProperty(editor, 'scrollHeight', {
            configurable: true,
            get: () => measuredHeight,
          });

          return {
            editor,
            getPlainText() {
              return latestValue
                .map((segment) => segment.type === 'text'
                  ? segment.text
                  : segment.trigger + segment.displayText)
                .join('');
            },
            getChangeCount() {
              return changeCount;
            },
            getHeight() {
              return editor.style.height;
            },
            setMeasuredHeight(height) {
              measuredHeight = height;
            },
            focus() {
              act(() => editor.focus());
            },
            placeCaretAtEnd() {
              setCaret(editor, editor.childNodes.length);
            },
            pressShiftEnter() {
              act(() => {
                editor.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'Enter',
                  code: 'Enter',
                  shiftKey: true,
                  bubbles: true,
                  cancelable: true,
                }));
              });
            },
            startComposition() {
              act(() => {
                editor.dispatchEvent(new CompositionEvent('compositionstart', {
                  bubbles: true,
                }));
              });
            },
            updateComposition(text) {
              act(() => {
                editor.textContent = text;
                setCaret(editor.firstChild, text.length);
                editor.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  inputType: 'insertCompositionText',
                  data: text,
                  isComposing: true,
                }));
              });
            },
            updateText(text) {
              act(() => {
                editor.textContent = text;
                setCaret(editor.firstChild ?? editor, text.length);
                editor.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  inputType: 'insertText',
                  data: text,
                  isComposing: false,
                }));
              });
            },
            commitCompositionIntoSentinel(text) {
              const sentinel = editor.querySelector('[data-sentinel="true"]');
              if (!sentinel) throw new Error('trailing-newline sentinel is missing');

              act(() => {
                sentinel.textContent = '\\u200B' + text;
                setCaret(sentinel.firstChild, sentinel.firstChild.textContent.length);
                editor.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  inputType: 'insertCompositionText',
                  data: text,
                  isComposing: true,
                }));
              });
            },
            endComposition(text) {
              act(() => {
                editor.dispatchEvent(new CompositionEvent('compositionend', {
                  bubbles: true,
                  data: text,
                }));
              });
            },
            flushLayout() {
              act(() => window.__flushAnimationFrames());
            },
            unmount() {
              act(() => root.unmount());
            },
          };
        }
        `,
        resolveDir: desktopDir,
        sourcefile: 'prompt-area-composition-harness.tsx',
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

test('composition end moves committed text out of the trailing-newline sentinel', async (t) => {
  const { container, restore } = installDom();
  let promptArea;

  t.after(() => {
    promptArea?.unmount();
    restore();
  });

  const importedHarness = await getImportedHarness();
  const firstLine = '大发大发 https://example.com';
  promptArea = importedHarness.harness.mount(container, firstLine);

  promptArea.placeCaretAtEnd();
  promptArea.pressShiftEnter();

  const sentinel = promptArea.editor.querySelector('[data-sentinel="true"]');
  assert.ok(sentinel, 'Shift+Enter at the end should render a trailing-newline sentinel');
  assert.ok(promptArea.editor.querySelector('br'), 'Shift+Enter should preserve the model newline');
  assert.ok(promptArea.editor.querySelector('a[data-url="true"]'), 'the existing URL should be decorated');

  const changesBeforeCancelledComposition = promptArea.getChangeCount();
  promptArea.startComposition();
  promptArea.endComposition('');
  assert.equal(
    promptArea.getChangeCount(),
    changesBeforeCancelledComposition,
    'cancelled composition must not emit a synthetic model change',
  );
  assert.ok(
    promptArea.editor.querySelector('[data-sentinel="true"]'),
    'cancelled composition must keep the trailing-newline sentinel',
  );

  promptArea.startComposition();
  promptArea.commitCompositionIntoSentinel('第二行');
  assert.equal(promptArea.getPlainText(), `${firstLine}\n第二行`);

  promptArea.endComposition('第二行');

  assert.equal(promptArea.getPlainText(), `${firstLine}\n第二行`);
  assert.equal(
    promptArea.editor.querySelector('[data-sentinel="true"]'),
    null,
    'committed IME text must not remain inside the internal sentinel',
  );
  assert.equal(promptArea.editor.lastChild.nodeType, Node.TEXT_NODE);
  assert.equal(promptArea.editor.lastChild.textContent, '第二行');
  assert.ok(
    promptArea.editor.querySelector('a[data-url="true"]'),
    'composition reconciliation must preserve existing URL decoration',
  );

  const selection = window.getSelection();
  assert.equal(selection.anchorNode, promptArea.editor.lastChild);
  assert.equal(selection.anchorOffset, '第二行'.length);
});

test('first composition ignores transient WebKit height and remeasures after commit', async (t) => {
  const { container, restore } = installDom();
  let promptArea;

  t.after(() => {
    promptArea?.unmount();
    restore();
  });

  const importedHarness = await getImportedHarness();
  promptArea = importedHarness.harness.mount(container, '', { autoGrow: true });

  promptArea.setMeasuredHeight(72);
  promptArea.focus();
  promptArea.flushLayout();
  assert.equal(promptArea.getHeight(), '72px');

  promptArea.startComposition();
  promptArea.setMeasuredHeight(260);
  promptArea.updateComposition('首');
  promptArea.flushLayout();
  assert.equal(
    promptArea.getHeight(),
    '72px',
    'marked-text layout must not expand a one-line editor to its maximum height',
  );

  promptArea.endComposition('首');
  assert.equal(
    promptArea.getHeight(),
    '72px',
    'composition end must wait for a stable layout frame before measuring',
  );

  promptArea.setMeasuredHeight(72);
  promptArea.flushLayout();
  assert.equal(promptArea.getPlainText(), '首');
  assert.equal(
    promptArea.getHeight(),
    '72px',
    'composition commit must remeasure the stabilized one-line editor',
  );

  promptArea.setMeasuredHeight(144);
  promptArea.updateText('首\n第二行\n第三行');
  promptArea.flushLayout();
  assert.equal(
    promptArea.getHeight(),
    '144px',
    'ordinary multiline input must still grow after composition ends',
  );

  promptArea.setMeasuredHeight(72);
  promptArea.updateText('首');
  promptArea.flushLayout();
  assert.equal(
    promptArea.getHeight(),
    '72px',
    'ordinary input must still shrink when content returns to one line',
  );
});
