import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { JSDOM } from 'jsdom';

const desktop = path.resolve(import.meta.dirname, '..');
const model = { changedFiles: [
  { path: 'docs/report.md', status: 'modified', source: 'matched' },
  { path: 'slow.md', status: 'modified', source: 'git' },
], todos: [], artifacts: [], failedTools: [], todoSource: 'unavailable', todoTotal: 0, todoCompleted: 0 };
const session = { runtime_id: 'one', provider: 'claude', provider_session_id: 'provider-one', project_dir: '/project/one', env_name: 'test', status: 'ready' };
const diff = { path: 'docs/report.md', is_repo: true, is_binary: false, lines: [{ kind: 'addition', text: 'changed text', new_line: 1 }], additions: 1, deletions: 0 };
const file = (content) => ({ content, is_binary: false, truncated: false, byte_size: content.length });
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

async function setup(t, invoke) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle']) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  }
  // React's bundled async act uses MessageChannel in this browser-like harness.
  // Match the browser queue without retaining Node worker-thread message ports.
  globalThis.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => setImmediate(() => this.port1.onmessage?.({ data })) };
    }
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.documentElement.dataset.performanceMode = 'reduced';
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.__sidePanelInvoke = invoke;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-side-panel-'));
  const output = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: { contents: `
      import React, { act, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { WorkspaceSidePanel, WorkspaceSidePanelContext, useWorkspaceSidePanelController } from '@/components/workspace/WorkspaceSidePanel';
      import { createBrowserActivationController } from '@/components/workspace/browserActivation';
      import { WorkspaceFileLinkContext } from '@/components/workspace/WorkspaceFileLinkContext';
      import { WorkspaceReviewPopover } from '@/components/workspace/WorkspaceReviewPopover';
      import { MarkdownRenderer } from '@/components/history/MarkdownRenderer';
      import { workspaceReviewTriggerRef } from '@/components/workspace/workspaceReviewAnchor';
      import { TooltipProvider } from '@/components/ui/tooltip';
      import { LocaleProvider } from '@/locales';
      let currentPanel;
      function App(props) {
        const panel = useWorkspaceSidePanelController(props.session.runtime_id, false);
        currentPanel = panel;
        const [review, setReview] = useState(true);
        return <LocaleProvider><TooltipProvider><WorkspaceSidePanelContext.Provider value={panel}><WorkspaceFileLinkContext.Provider value={{ workingDir: props.session.project_dir, openFile: path => panel.open('files', path) }}>
          <button ref={workspaceReviewTriggerRef} onClick={() => setReview(true)}>Review</button>
          <MarkdownRenderer content={'[Open report](ccem-file://preview?path=docs%2Freport.md) [Unsafe](javascript:alert(1))'} />
          <WorkspaceReviewPopover {...props} isOpen={review} onOpenChange={setReview} isRefreshingGit={false} onRefreshGit={() => {}} />
          <WorkspaceSidePanel controller={panel} width={50} onResizeStart={() => {}} onSelectBrowser={() => panel.open('browser')}><div id="retained-browser" hidden={panel.tab !== 'browser'}>Retained browser</div></WorkspaceSidePanel>
        </WorkspaceFileLinkContext.Provider></WorkspaceSidePanelContext.Provider></TooltipProvider></LocaleProvider>;
      }
      export { act, createBrowserActivationController };
      export function mount(node, props) {
        const root = createRoot(node);
        const render = async value => { await act(async () => { root.render(<App {...value} />); }); };
        return { render, panel: () => currentPanel, unmount: () => act(() => root.unmount()) };
      }
    `, resolveDir: desktop, sourcefile: 'side-panel-harness.tsx', loader: 'tsx' },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node20', tsconfig: path.join(desktop, 'tsconfig.json'),
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_PERF_MODE': 'undefined' }, logLevel: 'silent',
    plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /gsapMotion/ }, () => ({ path: 'motion', namespace: 'test' }));
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'test' }));
      builder.onResolve({ filter: /^@\/lib\/nativeSurfaceOcclusion$/ }, () => ({ path: 'occlusion', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: path === 'motion'
        ? 'import { useEffect } from "react"; export const useGSAP = (fn, options) => useEffect(fn, options?.dependencies ?? []); export const ccemMotion = { duration: { quick: 0, base: 0 }, ease: { standard: "none" } }; export const gsap = { utils: { toArray: (s,r) => Array.from((r||document).querySelectorAll(s)) }, set() {}, fromTo() {} }; export const shouldReduceMotion = () => true; export const clearMotionProps = () => {};'
        : path === 'ipc'
        ? 'export const invoke = (...args) => globalThis.__sidePanelInvoke(...args); export const convertFileSrc = p => p;'
        : 'export const useNativeSurfaceOcclusion = open => open; export const useNativeSurfaceOccluded = () => false; export const useNativeSurfaceOcclusionParticipant = () => {};', loader: 'js', resolveDir: desktop }));
    } }],
  });
  const { act, mount, createBrowserActivationController } = await import(pathToFileURL(output).href);
  const root = mount(document.getElementById('root'));
  const props = { session, model, onLoadDiff: async () => diff, onLoadSubagents: async () => ({ subagents: [] }) };
  await root.render(props);
  const settle = () => act(async () => { await tick(); });
  const click = async (element) => {
    assert.ok(element, 'click target exists');
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: false }));
      element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await tick();
    });
  };
  const byText = (text) => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text);
  t.after(async () => { await root.unmount(); dom.window.close(); await fs.rm(tempDir, { recursive: true, force: true }); stop(); });
  return { root, props, click, byText, settle, act, createBrowserActivationController };
}

test('review details move into the side panel; Markdown, source, diff and local links use the selected file', async (t) => {
  const calls = [];
  const h = await setup(t, async (command, args) => { calls.push({ command, ...args }); return file('# Rendered report\n\n**Ready**\n\n[Next](next.md)'); });
  await h.click(h.byText('改动文件2'));
  assert.equal(Boolean(document.querySelector('[data-ccem-workspace-review-popover]')), false, 'summary closed after navigation');
  assert.equal(document.querySelector('[data-ccem-workspace-side-panel]').dataset.ccemWorkspaceSidePanel, 'files');
  await h.click(document.querySelector('[data-review-file-row][title="docs/report.md"]'));
  assert.equal(document.querySelector('[data-ccem-markdown-preview] h1')?.textContent, 'Rendered report');
  assert.equal(document.querySelector('[data-ccem-markdown-preview] strong')?.textContent, 'Ready');
  assert.equal(calls.at(-1).workingDir, '/project/one');
  await h.click(h.byText('源码'));
  assert.match(document.querySelector('[data-ccem-file-source]').textContent, /# Rendered report/);
  await h.click(h.byText('Git 差异'));
  assert.match(document.querySelector('[data-review-page="files"]').textContent, /changed text/);
  const browser = document.getElementById('retained-browser');
  await h.click(h.byText('浏览器'));
  assert.equal(document.getElementById('retained-browser'), browser);
  assert.equal(browser.hidden, false);
  await h.click(h.byText('文件'));
  assert.equal(document.querySelector('[data-ccem-markdown-preview] h1')?.textContent, 'Rendered report', 'file survives a tab round trip');
  await h.click(document.querySelector('[data-ccem-file-link]'));
  assert.equal(browser.hidden, true);
  assert.equal(document.querySelector('[data-ccem-markdown-preview] h1')?.textContent, 'Rendered report');
  await h.click([...document.querySelectorAll('[data-ccem-markdown-preview] a')].find(a => a.textContent === 'Next'));
  assert.equal(calls.at(-1).filePath, 'docs/next.md');
  assert.equal(document.querySelector('a[href^="javascript:"]'), null);
});

test('browser rollback preserves later manual choices and closing fences pending activation', async (t) => {
  const h = await setup(t, async () => file('# Report'));
  let rollback;
  await h.act(async () => { h.root.panel().open('files', 'docs/report.md'); });
  await h.act(async () => { rollback = h.root.panel().open('browser'); });
  await h.act(async () => { rollback(); });
  assert.equal(h.root.panel().tab, 'files');
  assert.equal(h.root.panel().filePath, 'docs/report.md');
  await h.act(async () => { rollback = h.root.panel().open('browser'); });
  await h.act(async () => { h.root.panel().open('agents'); rollback(); });
  assert.equal(h.root.panel().tab, 'agents');
  await h.act(async () => { rollback = h.root.panel().open('browser'); });
  await h.act(async () => { h.root.panel().close(); rollback(); });
  assert.equal(h.root.panel().tab, null);
});

test('two failed native browser requests restore the original file tab', async (t) => {
  const h = await setup(t, async () => file('# Report'));
  await h.act(async () => { h.root.panel().open('files', 'docs/report.md'); });
  const activation = h.createBrowserActivationController({
    claim: async () => ({ ...session, is_active: true }),
    reject: async () => {},
    ownerFor: () => session.runtime_id,
    reveal: (_, owner) => h.root.panel().revealBrowser(owner),
  });
  const one = { runtime_id: session.runtime_id, request_id: 'first' };
  const two = { runtime_id: session.runtime_id, request_id: 'second' };
  await h.act(async () => { await activation.request(one); await activation.request(two); });
  await h.act(async () => { activation.complete({ ...one, activated: false }); });
  assert.equal(h.root.panel().tab, 'browser');
  await h.act(async () => { activation.complete({ ...two, activated: false }); });
  assert.equal(h.root.panel().tab, 'files');
  assert.equal(h.root.panel().filePath, 'docs/report.md');
});

test('Markdown images resolve next to the document through guarded workspace media IPC', async (t) => {
  const calls = [];
  const h = await setup(t, async (command, args) => {
    calls.push({ command, ...args });
    if (command === 'get_workspace_media_preview') return { kind: 'image', data_url: 'data:image/png;base64,AA==', byte_size: 1 };
    return file('# Report\n\n![Diagram](images/diagram.png)');
  });
  await h.click(document.querySelector('[data-ccem-file-link]'));
  await h.settle();
  assert.deepEqual(calls.at(-1), { command: 'get_workspace_media_preview', workingDir: '/project/one', filePath: 'docs/images/diagram.png' });
  assert.equal(document.querySelector('[data-ccem-markdown-preview] img')?.getAttribute('src'), 'data:image/png;base64,AA==');
});

test('late file responses and owner switches cannot replace the current preview', async (t) => {
  let resolveSlow;
  const h = await setup(t, async (command, args) => args.filePath === 'slow.md'
    ? new Promise(resolve => { resolveSlow = resolve; }) : file('# Current'));
  await h.click(document.querySelector('[data-ccem-file-link]'));
  await h.click(document.querySelector('[data-review-file-row][title="slow.md"]'));
  await h.click(document.querySelector('[data-review-file-row][title="docs/report.md"]'));
  await h.act(async () => { resolveSlow(file('# Stale')); await tick(); });
  assert.equal(document.querySelector('[data-ccem-markdown-preview] h1')?.textContent, 'Current');
  await h.click(document.querySelector('[data-review-file-row][title="slow.md"]'));
  await h.root.render({ ...h.props, session: { ...session, runtime_id: 'two', project_dir: '/project/two' } });
  await h.act(async () => { resolveSlow(file('# Old owner')); await tick(); });
  assert.equal(document.querySelector('[data-ccem-workspace-side-panel]').dataset.ccemWorkspaceSidePanel, 'closed');
  assert.equal(document.querySelector('[data-ccem-markdown-preview]'), null);
});

test('subagent detail opens in the same side panel and renders execution history', async (t) => {
  const h = await setup(t, async () => file(''));
  await h.root.render({ ...h.props, onLoadSubagents: async (id) => ({ subagents: [{ agentId: 'child-one', subagentType: 'Explore', description: 'Inspect files', status: 'completed', toolCount: 1, messageCount: 1 }], detail: id ? [{ uuid: 'child-message', msgType: 'assistant', content: 'Execution completed', segmentIndex: 0, isCompactBoundary: false }] : [] }) });
  await h.click([...document.querySelectorAll('[data-ccem-workspace-review-popover] button')].find(button => button.textContent.trim() === '子 Agent'));
  await h.settle();
  assert.equal(Boolean(document.querySelector('[data-ccem-workspace-review-popover]')), false);
  assert.equal(document.querySelector('[data-ccem-workspace-side-panel]').dataset.ccemWorkspaceSidePanel, 'agents');
  assert.match(document.querySelector('[data-review-page="agents"]').textContent, /Execution completed/);
});
