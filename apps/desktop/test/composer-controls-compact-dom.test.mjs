import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build, stop: stopEsbuild } = require('esbuild');
const { JSDOM } = require('jsdom');
import { pathToFileURL, fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next source shape.
    }
  }
  return null;
}

const stubsPlugin = {
  name: 'ccem-composer-compact-stubs',
  setup(builder) {
    builder.onResolve({ filter: /^@\/components\/prompt-area$/ }, (args) => {
      if (!args.importer.endsWith('WorkspaceSessionComposer.tsx')) return null;
      return { path: 'prompt-area-observer', namespace: 'composer-compact-stubs' };
    });
    builder.onLoad({ filter: /^prompt-area-observer$/, namespace: 'composer-compact-stubs' }, () => ({
      loader: 'tsx', resolveDir: desktopDir,
      contents: `
        import React from 'react';
        import { PromptArea as RealPromptArea } from ${JSON.stringify(path.join(desktopDir, 'src/components/prompt-area.tsx'))};
        export const PromptArea = React.forwardRef((props, ref) => {
          globalThis.__composerAttentionTrigger = props.onTriggerPanelChange;
          return <RealPromptArea {...props} ref={ref} />;
        });
      `,
    }));
    builder.onResolve({ filter: /^@\/lib\/webcontentRecovery$/ }, () => ({ path: 'recovery-stub', namespace: 'composer-compact-stubs' }));
    builder.onLoad({ filter: /^recovery-stub$/, namespace: 'composer-compact-stubs' }, () => ({
      loader: 'js', contents: 'export const isRecoveringWebcontent = () => Boolean(globalThis.window?.__ccemRecoveryTest);',
    }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
      path: 'tauri-core-stub', namespace: 'composer-compact-stubs',
    }));
    builder.onLoad({ filter: /^tauri-core-stub$/, namespace: 'composer-compact-stubs' }, () => ({
      loader: 'js',
      contents: 'export async function invoke(command, args) { return globalThis.__acceptanceInvoke ? globalThis.__acceptanceInvoke(command, args) : []; }',
    }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/webview$/ }, () => ({
      path: 'tauri-webview-stub', namespace: 'composer-compact-stubs',
    }));
    builder.onLoad({ filter: /^tauri-webview-stub$/, namespace: 'composer-compact-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function getCurrentWebview() {
          return { async onDragDropEvent() { return () => {}; } };
        }
      `,
    }));
  },
};

const aliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => ({
      path: await resolveDesktopSource(args.path),
    }));
  },
};

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-composer-compact-'));
  const outputPath = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { LocaleProvider } from '@/locales';
        import { TooltipProvider } from '@/components/ui/tooltip';
        import { WorkspaceSessionComposer } from '@/components/workspace/WorkspaceSessionComposer';
        import { ComposerControls } from '@/components/workspace/ComposerControls';
        export { mergeQueuePresenceRows } from '@/components/workspace/composerQueueMotion';

        export function mountCompactControls(container, { question = false, queue = false, steer = null } = {}) {
          function Harness({ question, queue }) {
            return (
              <LocaleProvider>
              <TooltipProvider>
                <WorkspaceSessionComposer
                value=""
                onValueChange={() => {}}
                onSubmit={() => {}}
                placeholder="composer input"
                canSubmit={false}
                submitLabel="send message"
                aboveComposer={question ? <div style={{ height: 440 }}><button>answer question</button></div> : null}
                queuedMessages={queue ? [{ id: 'queued', text: 'queued message', displayText: 'queued message', removable: true }] : []}
                queueCanFlush
                onFlushQueuedMessages={() => {}}
                onRemoveQueuedMessage={() => {}}
                queueCanSteer={Boolean(steer)}
                onSteerQueuedMessages={steer ?? undefined}
                controls={(
                  <ComposerControls
                    provider="claude"
                    envName="DeepSeek-V4-Flash"
                    permMode="yolo"
                    effort="high"
                    environments={[]}
                    onEnvChange={() => {}}
                    onPermModeChange={() => {}}
                    onEffortChange={() => {}}
                  />
                )}
                />
              </TooltipProvider>
              </LocaleProvider>
            );
          }

          const root = createRoot(container);
          act(() => root.render(<Harness question={question} queue={queue} />));

          return {
            setAttentionPanels({ question = false, queue = false } = {}) {
              act(() => root.render(<Harness question={question} queue={queue} />));
            },
            showTrigger() {
              act(() => globalThis.__composerAttentionTrigger({
                suggestions: Array.from({ length: 30 }, (_, index) => ({ value: String(index), label: 'file ' + index })),
                loading: false, selectedIndex: 0, triggerChar: '@',
                onSelect() {}, onDismiss() {},
              }));
            },
            driveResize(width) {
              act(() => {
                for (const callback of globalThis.__composerCompactResizeCallbacks ?? []) {
                  callback([{ contentRect: { width } }]);
                }
              });
            },
            unmount() {
              act(() => root.unmount());
            },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'harness.tsx',
      loader: 'tsx',
    },
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    plugins: [stubsPlugin, aliasPlugin],
    logLevel: 'silent',
    external: ['jsdom'],
  });
  const imported = await import(pathToFileURL(outputPath).href);
  return { ...imported, tempDir };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const { window } = dom;
  // JSDOM has no layout/scroll implementation; the tests inspect the rendered
  // scroll ownership only; pixel geometry is not verified by JSDOM.
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const previous = new Map();

  const expose = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };

  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })),
      };
    }
  }

  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('localStorage', window.localStorage);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  // JSDOM has no animation frames or layout: advertise reduced motion so
  // gsap-driven entry tweens (send button scale, attachment chips) are skipped
  // instead of warning about missing transform plugins.
  const matchMediaStub = (query) => ({
    matches: typeof query === 'string' && query.includes('prefers-reduced-motion'),
    addEventListener() {},
    removeEventListener() {},
  });
  window.matchMedia = matchMediaStub;
  expose('matchMedia', matchMediaStub);
  expose('MessageChannel', TestMessageChannel);
  expose('IS_REACT_ACT_ENVIRONMENT', true);

  for (const name of [
    'Node',
    'NodeFilter',
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

  // Controllable ResizeObserver: the composer footer compact state is driven
  // through these captured callbacks so tests can simulate width changes
  // without a layout engine.
  globalThis.__composerCompactResizeCallbacks = [];
  class ControllableResizeObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      globalThis.__composerCompactResizeCallbacks.push(this.callback);
    }
    unobserve() {}
    disconnect() {}
  }
  expose('ResizeObserver', ControllableResizeObserver);
  let nextAnimationFrameHandle = 1;
  const animationFrames = new Map();
  expose('requestAnimationFrame', (callback) => {
    const handle = nextAnimationFrameHandle++;
    animationFrames.set(handle, callback);
    return handle;
  });
  expose('cancelAnimationFrame', (handle) => animationFrames.delete(handle));

  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
    delete globalThis.__composerCompactResizeCallbacks;
    delete globalThis.__composerAttentionTrigger;
    while (animationFrames.size > 0) {
      for (const [handle, callback] of [...animationFrames]) {
        animationFrames.delete(handle);
        callback();
      }
    }
  };
}

function spanByText(container, text) {
  // Both label spans truncate; their non-compact wrappers do not — pick the
  // innermost label span, not an ancestor whose textContent happens to match.
  return [...container.querySelectorAll('span.truncate')]
    .find((node) => node.textContent === text) ?? null;
}

function assertNoNestedNativeScroller(dock) {
  const scrollers = [...dock.querySelectorAll('.overflow-y-auto')];
  for (const scroller of scrollers) {
    assert.equal(
      scroller.querySelector('.overflow-y-auto'),
      null,
      'attention sections must never nest one native scroller inside another',
    );
  }
}

// Exercise the real Composer and TriggerPopover: only the input's existing
// callback is driven directly, so no attention-container JSX is mocked.
for (const scenario of [
  { name: 'trigger alone', trigger: true, question: false, queue: false },
  { name: 'long question alone', trigger: false, question: true, queue: false },
  { name: 'queue alone', trigger: false, question: false, queue: true },
  { name: 'trigger plus queue', trigger: true, question: false, queue: true },
  { name: 'question plus queue', trigger: false, question: true, queue: true },
  { name: 'question plus trigger plus queue', trigger: true, question: true, queue: true },
]) {
  test(`attention dock preserves scroll access for ${scenario.name}`, async () => {
    const harness = await (importedHarnessPromise ??= importHarness());
    const restore = installDom();
    let mounted;
    try {
      const container = document.getElementById('root');
      mounted = harness.mountCompactControls(container, scenario);
      if (scenario.trigger) mounted.showTrigger();
      const dock = container.querySelector('[data-attention-state] > div');
      assert.ok(dock, 'the actual attention dock must render');
      assert.ok(dock.classList.contains('max-h-[min(45vh,400px)]'), 'the shared height budget remains bounded');
      assert.ok(dock.classList.contains('flex-col'), 'sections share the budget through a flex column');
      assert.equal(dock.classList.contains('overflow-y-auto'), false, 'the shared budget never becomes a second scroller');
      assertNoNestedNativeScroller(dock);
      const questionScroll = dock.querySelector('[data-composer-attention-scroll="interruption"]');
      const queueScroll = dock.querySelector('[data-composer-attention-scroll="queue"]');
      assert.equal(Boolean(questionScroll), scenario.question);
      assert.equal(Boolean(queueScroll), scenario.queue);
      if (questionScroll) {
        assert.ok(questionScroll.classList.contains('overflow-y-auto'));
        assert.ok(questionScroll.classList.contains('min-h-0'), 'the question flexes so later sections stay reachable');
      }
      if (queueScroll) {
        assert.ok(queueScroll.classList.contains('overflow-y-auto'));
        assert.ok(queueScroll.classList.contains('shrink-0'));
      }
      if (scenario.trigger) assert.ok(dock.querySelector('[data-radix-scroll-area-viewport]'), 'suggestions retain their own ScrollArea');
      if (scenario.question) assert.ok([...dock.querySelectorAll('button')].some(button => button.textContent === 'answer question'));
      if (scenario.queue) assert.match(dock.textContent, /queued message/);
    } finally {
      mounted?.unmount();
      restore();
    }
  });
}

test('attention dock keeps the suggestion list mounted while stacked panels change', async () => {
  const harness = await (importedHarnessPromise ??= importHarness());
  const restore = installDom();
  let mounted;
  try {
    const container = document.getElementById('root');
    mounted = harness.mountCompactControls(container, { question: true, queue: true });
    mounted.showTrigger();
    const dock = container.querySelector('[data-attention-state] > div');
    const viewport = dock.querySelector('[data-radix-scroll-area-viewport]');
    assert.ok(viewport);
    assertNoNestedNativeScroller(dock);

    mounted.setAttentionPanels();
    assert.equal(container.querySelector('[data-attention-state] > div'), dock, 'the same dock remains mounted');
    assert.equal(dock.querySelector('[data-radix-scroll-area-viewport]'), viewport, 'the suggestion list remains mounted');
    assert.equal(dock.querySelector('.overflow-y-auto'), null, 'a lone suggestion list owns the only scroller');
    assert.doesNotMatch(dock.textContent, /answer question|queued message/);

    mounted.setAttentionPanels({ queue: true });
    assert.ok(dock.querySelector('[data-composer-attention-scroll="queue"]'), 'adding a queue adds its own section scroller');
    assertNoNestedNativeScroller(dock);
    assert.equal(dock.querySelector('[data-radix-scroll-area-viewport]'), viewport);
  } finally {
    mounted?.unmount();
    restore();
  }
});

test('queue dock steer interrupts once and replaces the idle flush action', async () => {
  const harness = await (importedHarnessPromise ??= importHarness());
  const restore = installDom();
  let mounted;
  try {
    const container = document.getElementById('root');
    let steerCalls = 0;
    mounted = harness.mountCompactControls(container, { queue: true, steer: () => { steerCalls += 1; } });
    const queue = container.querySelector('[data-ccem-composer-queue]');
    const steer = queue.querySelector('[data-ccem-composer-queue-steer]');
    assert.ok(steer, 'a running turn with pending queue exposes steer');
    assert.equal(steer.closest('[data-composer-attention-scroll]'), null, 'the steer header never scrolls away with the rows');
    const buttons = [...queue.querySelectorAll('button')].filter((button) => !button.getAttribute('aria-label'));
    assert.deepEqual(buttons, [steer], 'steer is the only list-wide action while it is available');
    steer.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(steerCalls, 1);
    mounted.unmount();
    mounted = harness.mountCompactControls(container, { queue: true });
    assert.equal(container.querySelector('[data-ccem-composer-queue-steer]'), null, 'no steer without a running turn');
  } finally {
    mounted?.unmount();
    restore();
  }
});

test('queue presence keeps removed rows in place as leaving until their exit finishes', async () => {
  const { mergeQueuePresenceRows } = await (importedHarnessPromise ??= importHarness());
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };
  const initial = mergeQueuePresenceRows([], [a, b]);
  assert.deepEqual(initial.map((row) => [row.message.id, row.leaving]), [['a', false], ['b', false]]);
  assert.equal(mergeQueuePresenceRows(initial, [a, b]), initial, 'an unchanged queue keeps row identity');

  const dispatched = mergeQueuePresenceRows(initial, [b, c]);
  assert.deepEqual(
    dispatched.map((row) => [row.message.id, row.leaving]),
    [['a', true], ['b', false], ['c', false]],
    'the dispatched head stays first while it collapses; the new row appends',
  );
  const cancelledMiddle = mergeQueuePresenceRows(mergeQueuePresenceRows([], [a, b, c]), [a, c]);
  assert.deepEqual(cancelledMiddle.map((row) => [row.message.id, row.leaving]), [['a', false], ['b', true], ['c', false]]);
});

test('queue dock unmounts once every row has left', async () => {
  const harness = await (importedHarnessPromise ??= importHarness());
  const restore = installDom();
  let mounted;
  try {
    const container = document.getElementById('root');
    mounted = harness.mountCompactControls(container, { queue: true });
    assert.ok(container.querySelector('[data-ccem-composer-queued-message="queued"]'));
    mounted.setAttentionPanels({ queue: false });
    assert.equal(container.querySelector('[data-ccem-composer-queue]'), null, 'no stuck leaving rows after exit');
    assert.equal(container.querySelector('[data-attention-state]'), null);
    mounted.setAttentionPanels({ queue: true });
    assert.ok(container.querySelector('[data-ccem-composer-queued-message="queued"]'), 'a re-queued row renders again');
  } finally {
    mounted?.unmount();
    restore();
  }
});

test('composer controls collapse to icon-only when the footer goes narrow, and restore when it widens', async () => {
  const harness = importedHarnessPromise ?? (importedHarnessPromise = importHarness());
  const { mountCompactControls } = await harness;
  const restore = installDom();
  try {
    const container = document.getElementById('root');
    const mounted = mountCompactControls(container);

    const envLabel = spanByText(container, 'DeepSeek-V4-Flash');
    const permLabel = spanByText(container, 'YOLO');
    assert.ok(envLabel, 'environment label span should render');
    assert.ok(permLabel, 'permission label span should render');
    const compactHidden = 'group-data-[compact]/composer-footer:hidden';

    // Wide footer: full labels visible, no compact marker.
    mounted.driveResize(900);
    assert.equal(container.querySelector('[data-compact]'), null, 'wide footer must not be compact');

    // Narrow footer: compact marker lands on the footer row and both label
    // spans carry the compact-hidden variant. Icons stay rendered, and the
    // chevron affordances collapse with them (icon-only triggers).
    mounted.driveResize(500);
    const footer = container.querySelector('[data-compact]');
    assert.ok(footer, 'narrow footer should carry data-compact');
    assert.match(footer.className, /group\/composer-footer/);
    assert.ok(envLabel.className.includes(compactHidden), 'environment label must hide in compact mode');
    assert.ok(permLabel.className.includes(compactHidden), 'permission label must hide in compact mode');
    assert.equal(envLabel.textContent, 'DeepSeek-V4-Flash', 'label content is untouched — only presentation hides');
    const envChevron = [...footer.querySelectorAll('svg')].find(
      (svg) => svg.getAttribute('class')?.includes('group-data-[compact]/composer-footer:hidden')
      && !svg.getAttribute('class')?.includes('[&>svg]'),
    );
    assert.ok(envChevron, 'environment trigger chevron must carry the compact-hidden variant');
    const permTrigger = footer.querySelector('[role="combobox"]');
    assert.match(
      permTrigger.className,
      /group-data-\[compact\]\/composer-footer:\[&>svg\]:hidden/,
      'permission trigger must hide its direct-child chevron svg in compact mode',
    );

    // Borderline: just at/above the 640px threshold stays expanded.
    mounted.driveResize(640);
    assert.equal(container.querySelector('[data-compact]'), null, '640px footer stays expanded');

    // Below the threshold compact mode returns.
    mounted.driveResize(639);
    assert.ok(container.querySelector('[data-compact]'), '639px footer goes compact');

    // Widening again removes the marker.
    mounted.driveResize(800);
    assert.equal(container.querySelector('[data-compact]'), null, 'widening restores full labels');

    mounted.unmount();
  } finally {
    restore();
  }
});

test('composer footer compact threshold is wired through the shared footer row used by every composer surface', async () => {
  const component = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceSessionComposer.tsx'),
    'utf8',
  );
  // Every ComposerControls consumer (workspace home, history, native session
  // view) renders through this single footer row, so the compact contract has
  // one anchor.
  assert.match(component, /group\/composer-footer/);
  assert.match(component, /data-compact=\{composerFooterCompact \|\| undefined\}/);
  const controls = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'ComposerControls.tsx'),
    'utf8',
  );
  const occurrences = controls.match(/group-data-\[compact\]\/composer-footer:hidden/g) ?? [];
  assert.equal(
    occurrences.length,
    6,
    'env name, separator, gauge, effort text, permission label and env chevron all collapse',
  );
});
