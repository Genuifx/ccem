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

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
const INDEX_EXTENSIONS = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.json'];

async function resolveSourcePath(importPath) {
  const basePath = path.join(desktopDir, 'src', importPath.slice(2));
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  for (const filename of INDEX_EXTENSIONS) {
    const candidate = path.join(basePath, filename);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const desktopAliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = await resolveSourcePath(args.path);
      return resolved
        ? { path: resolved }
        : { errors: [{ text: `Could not resolve ${args.path}` }] };
    });
  },
};

/**
 * Interactive DOM harness for the composer usage panel's 用量/组成 view switch
 * (REQ-0043). Real timers, no `act()`: Radix's hover open/close delays are real
 * jsdom timers, and `act` eagerly flushes transition-priority work, which is
 * exactly the deferral whose removal this suite pins down. Interactions are
 * dispatched as DOM events and renders settle via short real-time waits.
 */
async function importUsagePanelHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-usage-panel-view-'));
  const outputPath = path.join(tempDir, 'usage-panel-view-harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { useCallback, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { LocaleProvider } from '@/locales';
        import { ContextWindowIndicator } from '@/components/workspace/ContextWindowIndicator';

        export function makeUsage(seed) {
          return {
            totalInputTokens: 1200 + seed,
            totalOutputTokens: 340,
            totalCacheReadTokens: 8000,
            totalCacheCreationTokens: 500,
            estimatedCostUsd: 0.42,
            turnCount: 3,
            context: {
              provider: 'claude',
              usedTokens: 42000,
              maxTokens: 200000,
              rawMaxTokens: null,
              percentage: 21,
              autoCompactThreshold: null,
              isAutoCompactEnabled: true,
              model: 'claude-sonnet-4',
              categories: [
                { name: 'System prompt', tokens: 4200 },
                { name: 'Messages', tokens: 21000 },
                { name: 'Free space', tokens: 158000 },
              ],
            },
            sessionUsage: null,
            routedLedger: null,
          };
        }

        let streamCallback = null;
        let streamSeed = 0;
        export function pumpStream() {
          if (streamCallback) streamCallback(makeUsage(streamSeed++));
        }

        function Host() {
          const [usage, setUsage] = useState(() => makeUsage(0));
          const setStreamUsage = useCallback((next) => setUsage(next), []);
          React.useEffect(() => {
            streamCallback = setStreamUsage;
            return () => { streamCallback = null; };
          }, [setStreamUsage]);
          return (
            <LocaleProvider>
              <ContextWindowIndicator
                usage={usage}
                provider="claude"
                onRefreshUsage={() => {}}
              />
            </LocaleProvider>
          );
        }

        export function mount(container) {
          const root = createRoot(container);
          root.render(<Host />);
          return { unmount: () => root.unmount() };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'usage-panel-view-harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [desktopAliasPlugin],
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  return { harnessPath: outputPath, tempDir };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // The MessageChannel stub routes the React scheduler's postMessage through a
  // microtask (same contract as the other DOM harnesses in this suite dir).
  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => {
          queueMicrotask(() => this.port1.onmessage?.({ data }));
        },
      };
    }
  }
  const names = {
    window,
    self: window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    MessageChannel: TestMessageChannel,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    PointerEvent: window.PointerEvent ?? window.MouseEvent,
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(names)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserver });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: ResizeObserver });
  Object.defineProperty(window, 'PointerEvent', {
    configurable: true,
    value: window.PointerEvent ?? window.MouseEvent,
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
      delete globalThis.ResizeObserver;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function panelContent() {
  return document.querySelector('[data-radix-popper-content-wrapper]')?.firstElementChild ?? null;
}

function bodyView() {
  const content = panelContent();
  if (!content) return 'closed';
  const text = content.textContent ?? '';
  const hasComposition = text.includes('上下文组成');
  const hasUsage = text.includes('上下文占用') || text.includes('会话总用量');
  if (hasComposition && hasUsage) return 'both';
  if (hasComposition) return 'composition';
  if (hasUsage) return 'usage';
  return 'empty';
}

function segmentButton(label) {
  const content = panelContent();
  if (!content) return null;
  return [...content.querySelectorAll('button')].find((button) => button.textContent === label) ?? null;
}

function ring() {
  return document.querySelector('button[aria-label="会话用量"]');
}

function isPinned() {
  // The pinned state adds the unprefixed `bg-background/70`; the idle ring
  // only ever carries the `hover:bg-background/70` variant.
  return /(^|\s)bg-background\/70/.test(ring()?.className ?? '');
}

/** React derives onPointerEnter from root-level pointerover/out, so a bubbling
 * `pointerover` on the ring is the hover-enter gesture (verified against the
 * installed @radix-ui/react-hover-card Trigger handlers). */
function hoverRing() {
  ring()?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 10, clientY: 10 }));
}

/** Hover-leave from the panel content: bubbling pointerout with the pointer
 * moving onto the document body (outside trigger and content). */
function hoverAwayFromContent() {
  const content = panelContent();
  content?.dispatchEvent(new MouseEvent('pointerout', {
    bubbles: true,
    cancelable: true,
    relatedTarget: document.body,
    clientX: 5,
    clientY: 5,
  }));
  document.body.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 5, clientY: 5 }));
}

async function openByHover() {
  hoverRing();
  // Radix openDelay is 200ms; leave margin for the scheduler + popper mount.
  await sleep(360);
}

test('REQ-0043: 用量/组成 view switch swaps the panel body in the click render, both pinned and unpinned', async () => {
  const dom = installDom();
  // Import AFTER the jsdom globals exist: Radix branches on globalThis.document
  // at module-eval time (its useLayoutEffect fallback would silently no-op).
  const { harnessPath, tempDir } = await importUsagePanelHarness();
  const harness = await import(pathToFileURL(harnessPath).href);
  const mounted = harness.mount(dom.container);
  await sleep(80);

  try {
    // Unpinned (hover) flow.
    await openByHover();
    assert.notEqual(bodyView(), 'closed', 'hover should open the usage panel');
    assert.equal(bodyView(), 'usage');
    assert.equal(isPinned(), false, 'hover alone must not pin the panel');

    const composition = segmentButton('组成');
    assert.ok(composition, '组成 segment should render once context data exists');

    // The switch must land in the same render as the click (next frame), and
    // the segment click engages the pinned reading mode so the swap resize
    // cannot auto-close the hover panel (REQ-0043 regression: the panel used
    // to keep showing the usage view after this click).
    composition.click();
    // React 18 flushes a discrete click's render on the microtask queue — the
    // same turn as the click, no timer/defer involvement.
    await null;
    assert.equal(bodyView(), 'composition', 'panel body must show the composition view immediately after the click');
    assert.equal(isPinned(), true, 'a segment click engages the pinned reading mode');

    const usage = segmentButton('用量');
    assert.ok(usage);
    usage.click();
    await null;
    assert.equal(bodyView(), 'usage');
    assert.equal(isPinned(), true);

    // Pinned-first flow (REQ-0035 contract): ring click pins, then switching
    // keeps working and the panel stays open.
    ring().click(); // dismiss (was pinned by the segment click)
    await sleep(60);
    assert.equal(bodyView(), 'closed');

    hoverRing();
    await sleep(360);
    ring().click(); // pin via the ring
    await sleep(60);
    assert.equal(isPinned(), true);
    segmentButton('组成')?.click();
    await null;
    assert.equal(bodyView(), 'composition');
  } finally {
    mounted.unmount();
    dom.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('REQ-0043: pinned-by-switch panel survives hover leave and closes via the explicit dismissal paths', async () => {
  const dom = installDom();
  const { harnessPath, tempDir } = await importUsagePanelHarness();
  const harness = await import(pathToFileURL(harnessPath).href);
  const mounted = harness.mount(dom.container);
  await sleep(80);

  try {
    await openByHover();
    segmentButton('组成')?.click();
    await null;
    assert.equal(bodyView(), 'composition');
    assert.equal(isPinned(), true);

    // The view-swap resize drops a resting pointer outside the hover surface;
    // Radix asks to close after closeDelay (200ms) — the pin must veto it.
    hoverAwayFromContent();
    await sleep(420);
    assert.equal(bodyView(), 'composition', 'hover leave after a view switch must not close the panel');

    // Escape is an explicit dismissal and still closes the pinned panel.
    const content = panelContent();
    content?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    await sleep(80);
    assert.equal(bodyView(), 'closed');
    assert.equal(isPinned(), false, 'dismissal clears the engaged pin');

    // Ring-click dismissal round trip: reopen by hover, switch (pins), then the
    // ring click toggles it off.
    await openByHover();
    segmentButton('用量')?.click();
    await null;
    assert.equal(bodyView(), 'usage');
    assert.equal(isPinned(), true);
    ring().click();
    await sleep(80);
    assert.equal(bodyView(), 'closed');
  } finally {
    mounted.unmount();
    dom.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('REQ-0043: 20 rapid 用量/组成 toggles all land on the clicked view and keep the panel open', async () => {
  const dom = installDom();
  const { harnessPath, tempDir } = await importUsagePanelHarness();
  const harness = await import(pathToFileURL(harnessPath).href);
  const mounted = harness.mount(dom.container);
  await sleep(80);

  try {
    await openByHover();
    const toggles = 20;
    const observed = [];
    for (let i = 0; i < toggles; i += 1) {
      const label = i % 2 === 0 ? '组成' : '用量';
      const button = segmentButton(label);
      assert.ok(button, `${label} segment must be present at toggle ${i}`);
      button.click();
      // The click's render flushes on the microtask queue; assert the landed
      // view in the same turn so a dropped or lagging switch cannot hide.
      await null;
      observed.push(bodyView());
    }
    const expected = Array.from({ length: toggles }, (_, i) => (i % 2 === 0 ? 'composition' : 'usage'));
    assert.deepEqual(observed, expected, 'every rapid toggle must land on the clicked view');
    assert.equal(bodyView(), 'usage', '20 toggles ends on the usage view');
    assert.notEqual(bodyView(), 'closed', 'panel must stay open through rapid switching');
    assert.equal(isPinned(), true);

    // The panel is still interactive after the burst.
    segmentButton('组成')?.click();
    await null;
    assert.equal(bodyView(), 'composition');
  } finally {
    mounted.unmount();
    dom.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('REQ-0043: view switch stays immediate under a busy usage-event stream and no deferred value is wired', async () => {
  const dom = installDom();
  const { harnessPath, tempDir } = await importUsagePanelHarness();
  const harness = await import(pathToFileURL(harnessPath).href);
  const mounted = harness.mount(dom.container);
  await sleep(80);

  try {
    await openByHover();
    // Simulate a live session: fresh usage objects arriving on an urgent
    // cadence (each is a DefaultLane re-render of the popover's parent, the
    // condition under which useDeferredValue lagged or lost the switch).
    const stream = setInterval(() => harness.pumpStream(), 30);
    try {
      await sleep(60);
      segmentButton('组成')?.click();
      await null;
      assert.equal(bodyView(), 'composition', 'switch must land while the stream is pumping');
      for (let i = 0; i < 4; i += 1) {
        await sleep(60);
        assert.equal(bodyView(), 'composition', `composition view must persist under the stream (sample ${i})`);
        harness.pumpStream();
      }
      segmentButton('用量')?.click();
      await null;
      assert.equal(bodyView(), 'usage');
    } finally {
      clearInterval(stream);
    }
  } finally {
    mounted.unmount();
    dom.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  // Structural guard: the deferred-value workaround that let the body lag
  // behind the segmented control must not come back for this view state.
  // (Prose comments may mention the API, so assert the actual wiring.)
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'SessionUsagePopover.tsx'),
    'utf8',
  );
  assert.doesNotMatch(source, /useDeferredValue\s*\(/, 'view swap must render synchronously (REQ-0043)');
  assert.doesNotMatch(source, /import\s*\{[^}]*useDeferredValue/, 'the deferred hook must not be imported (REQ-0043)');
  assert.match(source, /onEngage/, 'the popover must offer the pin-engagement callback');
});
