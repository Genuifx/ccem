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

        export function mount(container) {
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
                  'Alpha selected words here.',
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

    const pill = document.querySelector('[data-workspace-selection-action].fixed');
    assert.ok(pill, 'selection action pill should be portaled');
    assert.equal(pill.parentElement, document.body);
    assert.match(pill.className, /\bz-50\b/);
    assert.doesNotMatch(pill.className, /z-\[100\]/);

    const roseSwatch = pill.querySelector('[data-workspace-annotation-color="rose"]');
    const waveStyle = pill.querySelector('[data-workspace-annotation-style="wave"]');
    assert.ok(roseSwatch, 'color swatches should be in the selection toolbar');
    assert.ok(waveStyle, 'wave style should be in the selection toolbar');
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

    const copyButton = [...pill.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Copy');
    assert.ok(copyButton, 'copy action should be in the selection toolbar');
    harness.run(() => {
      copyButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await harness.flush();
    assert.equal(copiedText, 'selected words');
    assert.ok(
      [...pill.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Copied'),
      'copy action should acknowledge the clipboard write',
    );

    // Ask for a note, then submit the annotation.
    const addToTask = [...pill.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Add to task');
    assert.ok(addToTask, 'add-to-task action should exist');
    harness.run(() => {
      addToTask.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await harness.flush();

    assert.equal(
      pill.querySelector('[data-workspace-annotation-color="rose"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      pill.querySelector('[data-workspace-annotation-style="wave"]').getAttribute('aria-pressed'),
      'true',
    );

    const textarea = document.querySelector('textarea');
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