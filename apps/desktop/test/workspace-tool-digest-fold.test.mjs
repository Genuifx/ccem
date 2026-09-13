import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

const stubPlugin = {
  name: 'ccem-tool-digest-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({
      path: 'gsap-motion-stub', namespace: 'tool-digest-stubs',
    }));
    builder.onLoad({ filter: /^gsap-motion-stub$/, namespace: 'tool-digest-stubs' }, () => ({
      loader: 'js',
      contents: `
        export const ccemMotion = { duration: { quick: 0, base: 0 }, ease: { standard: 'none', soft: 'none' } };
        export function clearMotionProps() {}
        export const gsap = { fromTo() {}, set() {}, utils: { toArray() { return []; } } };
        export function shouldReduceMotion() { return true; }
        export function useGSAP() {}
      `,
    }));
    builder.onResolve({ filter: /^@\/locales$/ }, () => ({
      path: 'locale-stub', namespace: 'tool-digest-stubs',
    }));
    builder.onLoad({ filter: /^locale-stub$/, namespace: 'tool-digest-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function useLocale() { return { t(key) { return key; }, lang: 'zh' }; }
        export function LocaleProvider({ children }) { return children; }
      `,
    }));
  },
};

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-tool-digest-fold-'));
  const outputPath = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { WorkspaceToolDigest } from '@/components/workspace/WorkspaceMessageBubble';

        export function mount(container, initialProps) {
          const root = createRoot(container);
          const state = { props: initialProps };
          const render = () => act(() => {
            root.render(React.createElement(WorkspaceToolDigest, state.props));
          });
          render();
          return {
            setProps(nextProps) { state.props = nextProps; render(); },
            click(element) { act(() => element.click()); },
            unmount() { act(() => root.unmount()); },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'tool-digest-fold-harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [stubPlugin],
    define: { 'process.env.NODE_ENV': '"test"' },
    logLevel: 'silent',
  });
  return { harness: await import(pathToFileURL(outputPath).href), tempDir };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const expose = (name, value) => Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  expose('window', dom.window);
  expose('document', dom.window.document);
  expose('navigator', dom.window.navigator);
  expose('HTMLElement', dom.window.HTMLElement);
  expose('Element', dom.window.Element);
  expose('Event', dom.window.Event);
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  return dom;
}

const ENTRIES = [
  {
    type: 'tool_use',
    block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } },
  },
];

function gridWrapper(container) {
  // The animated container is the grid element directly after the divider.
  return container.querySelector('.grid');
}

test('programmatic digest expand/collapse skips the size transition; manual toggle keeps it', async () => {
  const dom = installDom();
  const { harness, tempDir } = await importHarness();
  const container = document.getElementById('root');
  try {
    const mounted = harness.mount(container, { entries: ENTRIES, autoExpanded: false, isActive: false });
    assert.equal(gridWrapper(container), null, 'body not rendered while closed and never expanded');

    // Streaming activates the digest: programmatic auto-expand must NOT
    // animate the height change (an animated fold is a content-height change
    // the scroll pin has to chase — the transcript jitter root cause).
    mounted.setProps({ entries: ENTRIES, autoExpanded: true, isActive: true });
    const autoGrid = gridWrapper(container);
    assert.ok(autoGrid, 'body rendered after auto expand');
    assert.doesNotMatch(autoGrid.className, /transition-all/, 'programmatic expand skips size transition');
    assert.match(autoGrid.className, /grid-rows-\[1fr\]/, 'expanded to full rows');

    // Losing active state: programmatic collapse, still no transition.
    mounted.setProps({ entries: ENTRIES, autoExpanded: false, isActive: false });
    const collapsedGrid = gridWrapper(container);
    assert.ok(collapsedGrid, 'body still mounted after collapse');
    assert.doesNotMatch(collapsedGrid.className, /transition-all/, 'programmatic collapse skips size transition');
    assert.match(collapsedGrid.className, /grid-rows-\[0fr\]/, 'collapsed to zero rows');

    // Manual click re-enables the animated transition for the user gesture.
    mounted.click(container.querySelector('button[aria-expanded]'));
    const manualGrid = gridWrapper(container);
    assert.ok(manualGrid, 'body mounted after manual click');
    assert.match(manualGrid.className, /transition-all/, 'manual toggle keeps the size transition');
    assert.match(manualGrid.className, /grid-rows-\[1fr\]/, 'manually expanded');

    mounted.unmount();
  } finally {
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    stopEsbuild();
  }
});
