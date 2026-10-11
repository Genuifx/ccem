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
        export { buildWorkspaceTranscriptItems } from '@/components/workspace/WorkspaceTranscriptList';

        export function mount(container, initialProps) {
          const root = createRoot(container);
          const state = { props: initialProps, renders: 0 };
          const ObservedDigest = React.memo((props) => {
            state.renders++;
            return React.createElement(WorkspaceToolDigest.type, props);
          }, WorkspaceToolDigest.compare);
          const render = () => act(() => {
            root.render(React.createElement(ObservedDigest, state.props));
          });
          render();
          return {
            renders: () => state.renders,
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

test('appending transcript text skips unchanged tool digests but still renders changed entries', async () => {
  const dom = installDom();
  const { harness, tempDir } = await importHarness();
  const container = document.getElementById('root');
  let mounted;
  try {
    const messages = [{
      msgType: 'assistant', uuid: 'completed-tool', segmentIndex: 0,
      content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/a.ts' } }],
    }];
    const first = harness.buildWorkspaceTranscriptItems(messages).find(item => item.type === 'tool-digest');
    mounted = harness.mount(container, { entries: first.entries, autoExpanded: false, isActive: false });
    const second = harness.buildWorkspaceTranscriptItems([
      ...messages,
      { msgType: 'assistant', uuid: 'next-text', segmentIndex: 0, content: 'New streamed answer.' },
    ]).find(item => item.key === first.key);
    const initialRenders = mounted.renders();
    mounted.setProps({ entries: second.entries, autoExpanded: false, isActive: false });
    assert.equal(mounted.renders(), initialRenders, 'unchanged historical digest should bail out');
    mounted.setProps({ entries: [...second.entries, ENTRIES[0]], autoExpanded: false, isActive: false });
    assert.equal(mounted.renders(), initialRenders + 1, 'appended tool must update the digest');
    const changedEntry = { ...second.entries[0], block: { ...second.entries[0].block, _result: 'late result' } };
    mounted.setProps({ entries: [changedEntry, ENTRIES[0]], autoExpanded: false, isActive: false });
    assert.equal(mounted.renders(), initialRenders + 2, 'late tool result must invalidate the digest');
    mounted.click(container.querySelector('button[aria-expanded]'));
    assert.match(gridWrapper(container).className, /grid-rows-\[1fr\]/, 'manual expansion still works');
  } finally {
    mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    stopEsbuild();
  }
});
