import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
import { pathToFileURL } from 'node:url';

const desktopDir = path.resolve(import.meta.dirname, '..');

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-annotation-placement-'));
  const outfile = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { WorkspaceTranscriptSelection } from '@/components/workspace/WorkspaceAnnotations';

        export function mount(container, html) {
          let addCalls = 0;
          let flushState = null;

          function Harness() {
            const viewportRef = useRef(null);
            const contentRef = useRef(null);
            const [annotations, setAnnotations] = useState([]);
            flushState = { setAnnotations, annotations };
            return React.createElement(
              'div',
              { ref: viewportRef, id: 'viewport', style: { overflow: 'auto', height: 600 } },
              React.createElement(
                'div',
                { ref: contentRef, id: 'content', style: { position: 'relative', height: 1200 } },
                React.createElement(
                  'div',
                  { 'data-transcript-item-key': 'message-a', id: 'item-a' },
                  html === undefined
                    ? 'Alpha selected words here.'
                    : React.createElement('div', { dangerouslySetInnerHTML: { __html: html } }),
                ),
                React.createElement(WorkspaceTranscriptSelection, {
                  rootRef: viewportRef,
                  contentRef: contentRef,
                  scopeKey: 'placement-test',
                  canAdd: true,
                  annotations,
                  onAdd: (quote, note, anchor, appearance) => {
                    addCalls += 1;
                    setAnnotations((current) => [...current, {
                      id: 'a-1',
                      quote,
                      note,
                      createdAt: '2026-01-01T00:00:00.000Z',
                      anchor,
                      ...(appearance ? {
                        highlightStyle: appearance.style,
                        highlightColor: appearance.color,
                      } : {}),
                    }]);
                    return true;
                  },
                  onUpdate: (id, note, appearance) => {
                    setAnnotations((current) => current.map((annotation) => (
                      annotation.id === id ? {
                        ...annotation,
                        note,
                        ...(appearance?.style ? { highlightStyle: appearance.style } : {}),
                        ...(appearance?.color ? { highlightColor: appearance.color } : {}),
                      } : annotation
                    )));
                    return true;
                  },
                  onRemove: () => {},
                }),
              ),
            );
          }

          const root = createRoot(container);
          act(() => root.render(React.createElement(Harness)));
          return {
            get addCalls() {
              return addCalls;
            },
            get annotations() {
              return flushState?.annotations ?? [];
            },
            unmount() {
              act(() => root.unmount());
            },
          };
        }

        export function run(fn) {
          act(() => fn());
        }

        export async function flush() {
          // Async act leaves React scheduler MessageChannel ports referenced
          // under Node's test runner; settle outside act and flush sync.
          await new Promise((resolve) => setTimeout(resolve, 20));
          act(() => {});
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'workspace-annotation-placement-harness.tsx',
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'desktop-alias-and-locale-stub',
      setup(builder) {
        builder.onResolve({ filter: /^@\/locales$/ }, () => ({
          path: 'locales',
          namespace: 'stub',
        }));
        builder.onLoad({ filter: /^locales$/, namespace: 'stub' }, () => ({
          loader: 'js',
          contents: `
            const labels = {
              'workspace.selectionAddToTask': 'Add to task',
              'workspace.selectionAnnotationLimit': 'Annotation limit reached',
              'workspace.selectionAnnotationAdd': 'Add',
              'workspace.selectionAnnotationPlaceholder': 'Note',
              'workspace.selectionAnnotationSubmitHint': 'Cmd+Enter',
              'workspace.selectionTooLong': 'Selection too long',
              'workspace.composerAnnotationEdit': 'Edit annotation',
              'workspace.composerAnnotationRemove': 'Remove annotation',
              'workspace.annotationAppearance': 'Annotation style',
              'workspace.annotationStyleMarker': 'Marker',
              'workspace.annotationStyleWave': 'Wave',
              'workspace.annotationCopy': 'Copy',
              'workspace.annotationCopied': 'Copied',
              'workspace.annotationCopyFailed': 'Copy failed',
              'workspace.annotationColorRose': 'Rose',
              'workspace.annotationColorViolet': 'Violet',
              'workspace.annotationColorBlue': 'Blue',
              'workspace.annotationColorGreen': 'Green',
              'workspace.annotationColorAmber': 'Amber',
              'workspace.annotationSaveFailed': 'Save failed',
              'common.cancel': 'Cancel',
              'common.save': 'Save',
            };
            export function useLocale() {
              return { t: (key) => labels[key] || key };
            }
          `,
        }));
        builder.onResolve({ filter: /^@\// }, async (args) => {
          const resolved = await resolveDesktopSource(args.path);
          return resolved
            ? { path: resolved }
            : { errors: [{ text: `Cannot resolve ${args.path}` }] };
        });
      },
    }],
    logLevel: 'silent',
  });
  return {
    harness: await import(pathToFileURL(outfile).href),
    tempDir,
  };
}

function domRect(left, top, right, bottom) {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON() {
      return this;
    },
  };
}

function installDom() {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="outside">Outside</button><div id="root"></div></body></html>',
    { url: 'http://localhost/' },
  );
  const { window } = dom;
  const expose = (name, value) => Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });

  for (const name of [
    'Node',
    'NodeFilter',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLTextAreaElement',
    'HTMLButtonElement',
    'SVGElement',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'CustomEvent',
    'MutationObserver',
    'DOMRect',
    'Range',
  ]) {
    expose(name, window[name]);
  }
  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  expose('requestAnimationFrame', (callback) => setTimeout(() => callback(Date.now()), 0));
  expose('cancelAnimationFrame', clearTimeout);

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => {
          setImmediate(() => this.port1.onmessage?.({ data }));
        },
      };
    }
  }
  Object.defineProperty(window, 'PointerEvent', {
    configurable: true,
    value: window.MouseEvent,
  });
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserver,
  });
  Object.defineProperty(window, 'MessageChannel', {
    configurable: true,
    value: TestMessageChannel,
  });

  return dom;
}

test('annotation highlights and markers live in content coordinates and ignore scrolling', async () => {
  const dom = installDom();
  const { window } = dom;
  const { harness, tempDir } = await importHarness();
  const { document } = window;
  let api = null;

  try {
    const container = document.getElementById('root');
    api = harness.mount(container);

    const viewport = document.getElementById('viewport');
    const content = document.getElementById('content');
    // Simulate a transcript scrolled down: the content box top is above the
    // viewport while its own coordinate space stays stable.
    viewport.getBoundingClientRect = () => domRect(0, 0, 800, 600);
    content.getBoundingClientRect = () => domRect(100, -50, 900, 1150);

    let copiedText = null;
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          copiedText = text;
        },
      },
    });

    let rangeMeasurements = 0;
    window.Range.prototype.getClientRects = function getClientRects() {
      rangeMeasurements += 1;
      return [domRect(150, 100, 300, 118)];
    };

    const textNode = document.getElementById('item-a').firstChild;
    const selectionRange = document.createRange();
    selectionRange.setStart(textNode, 6);
    selectionRange.setEnd(textNode, 20);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(selectionRange);
    assert.equal(selection.toString(), 'selected words');

    harness.run(() => {
      document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
    });
    await harness.flush();

    const colorBubble = document.querySelector('[data-workspace-annotation-color-bubble]');
    const actionBar = document.querySelector('[data-workspace-annotation-action-bar]');
    assert.ok(colorBubble, 'color palette should float in its own bubble');
    assert.ok(actionBar, 'annotation actions should share one toolbar');
    assert.equal(colorBubble.parentElement, document.body);
    assert.equal(actionBar.parentElement, document.body);
    assert.match(colorBubble.className, /\bz-50\b/);
    assert.match(actionBar.className, /\bz-50\b/);
    assert.doesNotMatch(actionBar.className, /z-\[100\]/);

    const roseSwatch = colorBubble.querySelector('[data-workspace-annotation-color="rose"]');
    const waveStyle = actionBar.querySelector('[data-workspace-annotation-style="wave"]');
    assert.ok(roseSwatch, 'color swatches should live in the color bubble');
    assert.ok(waveStyle, 'wave style should live in the action bar');
    assert.equal(actionBar.contains(roseSwatch), false, 'colors must not be inlined into the action bar');
    assert.equal(colorBubble.contains(waveStyle), false, 'styles must not be inlined into the color bubble');
    harness.run(() => {
      roseSwatch.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      waveStyle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await harness.flush();

    const candidateHighlight = document.querySelector('[data-workspace-selection-highlight="candidate"]');
    assert.match(candidateHighlight.className, /workspace-annotation-mark-wave/);
    assert.match(candidateHighlight.className, /workspace-annotation-color-rose/);
    assert.equal(candidateHighlight.getAttribute('data-annotation-color'), 'rose');
    assert.equal(
      window.localStorage.getItem('ccem:workspace-annotation-appearance:v1'),
      '{"style":"wave","color":"rose"}',
    );

    const copyButton = actionBar.querySelector('button[aria-label="Copy"]');
    assert.ok(copyButton, 'copy action should be in the action bar');
    harness.run(() => {
      copyButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await harness.flush();
    assert.equal(copiedText, 'selected words');
    assert.equal(
      copyButton.getAttribute('aria-label'),
      'Copied',
      'copy action should acknowledge the clipboard write',
    );

    // Ask for a note, then submit the annotation.
    const addToTask = [...actionBar.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Add to task');
    assert.ok(addToTask, 'add-to-task action should exist');
    harness.run(() => {
      addToTask.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await harness.flush();

    const editingPanel = [...document.querySelectorAll('[data-workspace-selection-action].fixed')]
      .find((panel) => panel.querySelector('textarea'));
    assert.ok(editingPanel, 'note editor should open');
    assert.equal(
      editingPanel.querySelector('[data-workspace-annotation-color="rose"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      editingPanel.querySelector('[data-workspace-annotation-style="wave"]').getAttribute('aria-pressed'),
      'true',
    );

    const textarea = editingPanel.querySelector('textarea');
    assert.ok(textarea);
    harness.run(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      ).set;
      setter.call(textarea, 'tighten this copy');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await harness.flush();

    const addButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Add');
    assert.ok(addButton, 'annotation submit button should exist');
    harness.run(() => {
      addButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await harness.flush();
    assert.equal(api.addCalls, 1);

    const highlight = document.querySelector('[data-workspace-selection-highlight="saved"]');
    assert.ok(highlight, 'saved highlight should render');
    assert.equal(highlight.closest('#content'), content);
    assert.match(highlight.className, /\babsolute\b/);
    assert.doesNotMatch(highlight.className, /\bfixed\b/);
    assert.equal(highlight.style.left, '50px');
    assert.equal(highlight.style.top, '150px');

    assert.match(highlight.className, /workspace-annotation-mark-wave/);
    assert.match(highlight.className, /workspace-annotation-color-rose/);
    assert.equal(highlight.getAttribute('data-annotation-style'), 'wave');
    assert.equal(highlight.getAttribute('data-annotation-color'), 'rose');

    const marker = document.querySelector('[data-workspace-annotation-marker]');
    assert.ok(marker, 'numbered marker should render');
    assert.equal(marker.closest('#content'), content);
    assert.match(marker.className, /\babsolute\b/);
    assert.doesNotMatch(marker.className, /\bfixed\b/);
    assert.equal(marker.style.left, '208px');
    assert.equal(marker.style.top, '148px');
    const markerBadge = marker.querySelector('button');
    assert.match(markerBadge.className, /workspace-annotation-marker-badge/);
    assert.match(markerBadge.className, /workspace-annotation-color-rose/);

    assert.equal(api.annotations[0].highlightStyle, 'wave');
    assert.equal(api.annotations[0].highlightColor, 'rose');

    // Restyle the saved annotation from its editor.
    harness.run(() => {
      markerBadge.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await harness.flush();

    const savedEditor = [...document.querySelectorAll('[data-workspace-selection-action].fixed')]
      .find((panel) => panel.querySelector('textarea'));
    assert.ok(savedEditor, 'saved annotation editor should open');
    const greenSwatch = savedEditor.querySelector('[data-workspace-annotation-color="green"]');
    const markerStyle = savedEditor.querySelector('[data-workspace-annotation-style="selection"]');
    assert.ok(greenSwatch && markerStyle);
    harness.run(() => {
      greenSwatch.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      markerStyle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await harness.flush();

    const restyledHighlight = document.querySelector('[data-workspace-selection-highlight="saved"]');
    assert.match(restyledHighlight.className, /workspace-annotation-mark-selection/);
    assert.match(restyledHighlight.className, /workspace-annotation-color-green/);
    assert.equal(api.annotations[0].highlightStyle, 'selection');
    assert.equal(api.annotations[0].highlightColor, 'green');
    // Editing an existing annotation does not change the next-selection default.
    assert.equal(
      window.localStorage.getItem('ccem:workspace-annotation-appearance:v1'),
      '{"style":"wave","color":"rose"}',
    );

    harness.run(() => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    });
    await harness.flush();

    const measurementsBeforeScroll = rangeMeasurements;
    // Native scrolling moves the content box. Content-space placements stay
    // put and, crucially, the scroll event must not trigger any rect reads or
    // React updates.
    content.getBoundingClientRect = () => domRect(100, -500, 900, 700);
    harness.run(() => {
      viewport.dispatchEvent(new window.Event('scroll'));
    });
    await harness.flush();
    assert.equal(rangeMeasurements, measurementsBeforeScroll);

    const markerAfterScroll = document.querySelector('[data-workspace-annotation-marker]');
    assert.equal(markerAfterScroll.style.left, '208px');
    assert.equal(markerAfterScroll.style.top, '148px');
  } finally {
    api?.unmount();
    dom.window.close();
    await stopEsbuild();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

const multiNodeSelections = [
  {
    name: 'paragraphs',
    html: '<p>Unselected prefix.</p><p id="selection-start">Alpha first paragraph.</p><p>Middle paragraph.</p><p id="selection-end">Omega final paragraph.</p>',
    expected: 'pha first paragraph.Middle paragraph.Omega',
  },
  {
    name: 'bold text',
    html: '<p>Unselected prefix.<span id="selection-start">Alpha </span><strong>bold middle</strong><span id="selection-end">Omega tail.</span></p>',
    expected: 'pha bold middleOmega',
  },
  {
    name: 'table cells',
    html: '<table><tbody><tr><td>Unselected prefix.</td><td id="selection-start">Alpha cell</td><td>Middle cell</td><td id="selection-end">Omega cell</td></tr></tbody></table>',
    expected: 'pha cellMiddle cellOmega',
  },
  {
    name: 'table rows',
    html: '<table><tbody><tr><td>Unselected prefix.</td><td id="selection-start">Alpha cell</td></tr><tr><td>Middle cell</td><td id="selection-end">Omega cell</td></tr></tbody></table>',
    expected: 'pha cellMiddle cellOmega',
  },
];

for (const selectionCase of multiNodeSelections) {
  test(`selecting across ${selectionCase.name} opens the toolbar and saves the complete quote`, async () => {
    const dom = installDom();
    const { window } = dom;
    const { document } = window;
    const { harness, tempDir } = await importHarness();
    const errors = [];
    window.addEventListener('error', (event) => {
      errors.push(event.error?.message ?? event.message);
      event.preventDefault();
    });
    let api = null;

    try {
      api = harness.mount(document.getElementById('root'), selectionCase.html);
      const viewport = document.getElementById('viewport');
      const content = document.getElementById('content');
      viewport.getBoundingClientRect = () => domRect(0, 0, 800, 600);
      content.getBoundingClientRect = () => domRect(0, 0, 800, 1200);
      window.Range.prototype.getClientRects = () => [domRect(150, 100, 300, 118)];

      const range = document.createRange();
      range.setStart(document.getElementById('selection-start').firstChild, 2);
      range.setEnd(document.getElementById('selection-end').firstChild, 5);
      assert.equal(range.cloneContents().textContent, selectionCase.expected);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      harness.run(() => {
        document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
      });
      await harness.flush();

      assert.deepEqual(errors, [], 'capturing a multi-node selection must not throw');
      const actionBar = document.querySelector('[data-workspace-annotation-action-bar]');
      assert.ok(actionBar, 'the selection toolbar should open');
      assert.ok(document.querySelector('[data-workspace-selection-highlight="candidate"]'));
      const addToTask = [...actionBar.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === 'Add to task');
      assert.ok(addToTask);
      harness.run(() => addToTask.click());
      await harness.flush();

      const textarea = document.querySelector('[data-workspace-selection-action] textarea');
      assert.ok(textarea, 'the note editor should open');
      harness.run(() => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          .call(textarea, `Review ${selectionCase.name}`);
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await harness.flush();
      const addButton = [...document.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === 'Add');
      assert.ok(addButton);
      harness.run(() => addButton.click());
      await harness.flush();

      assert.equal(api.addCalls, 1);
      assert.equal(api.annotations[0].quote, selectionCase.expected);
      assert.equal(api.annotations[0].note, `Review ${selectionCase.name}`);
      assert.ok(document.querySelector('[data-workspace-selection-highlight="saved"]'),
        'the saved multi-node anchor should resolve and render its highlight');
      assert.ok(document.querySelector('[data-workspace-annotation-marker]'));
      assert.deepEqual(errors, [], 'resolving the saved anchor must not throw');

      // Re-measure after a content mutation to exercise the cached batch resolver.
      harness.run(() => {
        document.getElementById('item-a').append(document.createTextNode('Later text.'));
      });
      await new Promise((resolve) => setTimeout(resolve, 220));
      await harness.flush();
      assert.ok(document.querySelector('[data-workspace-selection-highlight="saved"]'));
      assert.equal(api.annotations[0].quote, selectionCase.expected);
      assert.deepEqual(errors, []);
    } finally {
      api?.unmount();
      dom.window.close();
      await stopEsbuild();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
}
