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

        export function mountCompactControls(container, {
          question = false,
          queue = false,
          steer = null,
          provider = 'claude',
          envName = 'DeepSeek-V4-Flash',
          compact = false,
          permMode = 'yolo',
          codexInstalled = false,
          agyInstalled = false,
          opencodeInstalled = false,
          onLaunchNewSession = null,
          workingDir = null,
          sessionReferencesClient = null,
          onValueChange = null,
        } = {}) {
          function Harness({ question, queue }) {
            const [value, setValue] = React.useState('');
            return (
              <LocaleProvider>
              <TooltipProvider>
                <WorkspaceSessionComposer
                value={value}
                onValueChange={(nextValue) => {
                  setValue(nextValue);
                  onValueChange?.(nextValue);
                }}
                onSubmit={() => {}}
                placeholder="composer input"
                compact={compact}
                canSubmit={false}
                submitLabel="send message"
                provider={provider}
                workingDir={workingDir}
                codexInstalled={codexInstalled}
                agyInstalled={agyInstalled}
                opencodeInstalled={opencodeInstalled}
                onLaunchNewSession={onLaunchNewSession ?? undefined}
                sessionReferencesClient={sessionReferencesClient ?? undefined}
                aboveComposer={question ? <div style={{ height: 440 }}><button>answer question</button></div> : null}
                queuedMessages={queue ? [{ id: 'queued', text: 'queued message', displayText: 'queued message', removable: true }] : []}
                queueCanFlush
                onFlushQueuedMessages={() => {}}
                onRemoveQueuedMessage={() => {}}
                queueCanSteer={Boolean(steer)}
                onSteerQueuedMessages={steer ?? undefined}
                controls={(
                  <ComposerControls
                    provider={provider}
                    envName={envName}
                    permMode={permMode}
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
            act,
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
  const restoreBootstrapDom = installDom();
  let imported;
  try {
    imported = await import(pathToFileURL(outputPath).href);
  } finally {
    restoreBootstrapDom();
  }
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
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  Object.defineProperty(window, 'PointerEvent', {
    configurable: true,
    value: window.PointerEvent ?? window.MouseEvent,
  });
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
    'DocumentFragment',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLTextAreaElement',
    'SVGElement',
    'HTMLBRElement',
    'HTMLAnchorElement',
    'Event',
    'UIEvent',
    'FocusEvent',
    'CustomEvent',
    'InputEvent',
    'CompositionEvent',
    'KeyboardEvent',
    'MouseEvent',
    'PointerEvent',
    'Blob',
    'File',
    'FileReader',
    'MutationObserver',
    'DOMRect',
    'Range',
  ]) {
    expose(name, window[name]);
  }
  const previousCreateObjectUrl = URL.createObjectURL;
  const previousRevokeObjectUrl = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:mock-image';
  URL.revokeObjectURL = () => {};

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
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: ControllableResizeObserver,
  });
  expose('ResizeObserver', ControllableResizeObserver);
  const animationTimers = new Set();
  const rafStub = (callback) => {
    const handle = setTimeout(() => {
      animationTimers.delete(handle);
      callback(Date.now());
    }, 0);
    animationTimers.add(handle);
    return handle;
  };
  const cafStub = (handle) => {
    animationTimers.delete(handle);
    clearTimeout(handle);
  };
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: rafStub });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: cafStub });
  expose('requestAnimationFrame', rafStub);
  expose('cancelAnimationFrame', cafStub);

  return () => {
    for (const handle of animationTimers) {
      clearTimeout(handle);
    }
    animationTimers.clear();
    URL.createObjectURL = previousCreateObjectUrl;
    URL.revokeObjectURL = previousRevokeObjectUrl;
    for (const [name, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
    delete globalThis.__composerCompactResizeCallbacks;
    delete globalThis.__composerAttentionTrigger;
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

test('composer controls narrow and compact thresholds preserve model identity across breakpoints', async () => {
  const harness = importedHarnessPromise ?? (importedHarnessPromise = importHarness());
  const { mountCompactControls } = await harness;
  const restore = installDom();
  try {
    const container = document.getElementById('root');
    const mounted = mountCompactControls(container, {
      onLaunchNewSession: () => {},
      codexInstalled: true,
      agyInstalled: true,
    });

    const envLabel = spanByText(container, 'DeepSeek-V4-Flash');
    assert.ok(envLabel, 'environment label span should render');
    assert.equal(
      envLabel.className.includes('max-[760px]:hidden'),
      false,
      'model label must not collapse from window-width media queries',
    );
    assert.equal(
      spanByText(container, 'YOLO'),
      null,
      'permission trigger must stay icon-only without visible YOLO text',
    );
    const permTrigger = container.querySelector('[data-testid="composer-permission-trigger"]');
    assert.ok(permTrigger, 'permission trigger should render');
    assert.equal(permTrigger.getAttribute('aria-label'), 'YOLO');
    assert.match(permTrigger.className, /\btext-destructive\b/);
    const engineTrigger = container.querySelector('[data-testid="composer-engine-trigger"]');
    assert.ok(engineTrigger, 'engine trigger should render beside quick menu');
    assert.equal(engineTrigger.querySelectorAll('span.truncate').length, 0, 'engine trigger stays icon-only');
    assert.equal(engineTrigger.querySelectorAll('svg').length, 1, 'engine trigger omits dropdown chevron');
    const modelTrigger = container.querySelector('[data-testid="composer-model-effort-trigger"]');
    assert.ok(modelTrigger, 'model trigger should render');
    assert.equal(modelTrigger.getAttribute('aria-label'), 'DeepSeek-V4-Flash · 高');
    assert.equal(modelTrigger.querySelectorAll('svg').length, 2, 'model trigger renders icon + effort gauge without dropdown chevron');
    assert.match(modelTrigger.className, /group-data-\[compact\]\/composer-footer:bg-foreground\/\[0\.045\]/);
    assert.match(modelTrigger.className, /group-data-\[compact\]\/composer-footer:ring-1/);

    const effortTextSpan = [...modelTrigger.querySelectorAll('span')]
      .find((node) => node.textContent === '高') ?? null;
    assert.ok(effortTextSpan, 'effort text span should render');
    const effortCluster = effortTextSpan.parentElement;
    assert.ok(effortCluster, 'effort cluster wrapper should render');
    assert.ok(
      effortCluster.className.includes('group-data-[narrow]/composer-footer:hidden'),
      'effort cluster hides at data-narrow so model label keeps priority',
    );
    assert.equal(
      effortCluster.className.includes('max-[760px]:hidden'),
      false,
      'effort cluster must not collapse from window-width media queries',
    );
    const compactHidden = 'group-data-[compact]/composer-footer:hidden';
    assert.ok(envLabel.className.includes(compactHidden), 'environment label hides only in compact mode');
    assert.ok(effortTextSpan.className.includes(compactHidden), 'effort text hides in compact mode while gauge icon remains');

    // Sidebar-open small window (~556px footer): stays expanded with model + effort visible.
    mounted.driveResize(556);
    assert.equal(container.querySelector('[data-compact]'), null, '556px footer must not be compact');
    assert.equal(container.querySelector('[data-narrow]'), null, '556px footer must not be narrow');

    // Narrow band (340..439): marks data-narrow to hide effort text while preserving model label.
    mounted.driveResize(400);
    assert.ok(container.querySelector('[data-narrow]'), '400px footer should carry data-narrow');
    assert.equal(container.querySelector('[data-compact]'), null, '400px footer stays non-compact');

    // Boundary: 340px stays in narrow band (non-compact); 339px and 300px enter compact capsule mode.
    mounted.driveResize(340);
    assert.ok(container.querySelector('[data-narrow]'), '340px footer stays in data-narrow');
    assert.equal(container.querySelector('[data-compact]'), null, '340px footer must not go compact');

    for (const width of [339, 300]) {
      mounted.driveResize(width);
      const footer = container.querySelector('[data-compact]');
      assert.ok(footer, `${width}px footer should carry data-compact`);
      assert.equal(container.querySelector('[data-narrow]'), null, `${width}px compact footer clears data-narrow`);
      assert.match(footer.className, /group\/composer-footer/);
      assert.equal(envLabel.textContent, 'DeepSeek-V4-Flash', 'label content is untouched — only presentation hides');
      assert.equal(modelTrigger.querySelectorAll('svg').length, 2, 'compact model capsule retains icon + effort glyph');
      const comboboxTrigger = footer.querySelector('[role="combobox"]');
      assert.equal(comboboxTrigger, permTrigger);
      assert.match(
        permTrigger.className,
        /\[&>svg\]:hidden/,
        'permission trigger must hide its built-in chevron svg at all widths',
      );
    }

    // Widening again clears both compact and narrow markers.
    mounted.driveResize(800);
    assert.equal(container.querySelector('[data-compact]'), null, 'widening restores full labels');
    assert.equal(container.querySelector('[data-narrow]'), null, 'widening clears data-narrow');

    mounted.unmount();
  } finally {
    restore();
  }
});

test('compact composer distinguishes same-vendor Engine and Model triggers visually and via aria-label', async () => {
  const harness = importedHarnessPromise ?? (importedHarnessPromise = importHarness());
  const { mountCompactControls } = await harness;
  const restore = installDom();
  let mounted;
  try {
    const container = document.getElementById('root');
    mounted = mountCompactControls(container, {
      provider: 'claude',
      envName: 'Claude-Opus',
      compact: true,
      codexInstalled: true,
      agyInstalled: true,
      onLaunchNewSession: () => {},
    });

    const footer = container.querySelector('[data-compact]');
    assert.ok(footer, 'compact split composer sets data-compact');
    const engineTrigger = container.querySelector('[data-testid="composer-engine-trigger"]');
    const modelTrigger = container.querySelector('[data-testid="composer-model-effort-trigger"]');
    assert.ok(engineTrigger && modelTrigger);

    // Engine keeps a borderless single-icon trigger; Model becomes a dual-icon paired capsule.
    assert.equal(engineTrigger.querySelectorAll('svg').length, 1);
    assert.equal(engineTrigger.className.includes('ring-1'), false);
    assert.equal(modelTrigger.getAttribute('aria-label'), 'Claude-Opus · 高');
    assert.equal(modelTrigger.querySelectorAll('svg').length, 2);
    assert.match(modelTrigger.className, /group-data-\[compact\]\/composer-footer:bg-foreground\/\[0\.045\]/);
    assert.match(modelTrigger.className, /group-data-\[compact\]\/composer-footer:ring-1/);
  } finally {
    mounted?.unmount();
    restore();
  }
});

test('ComposerEnginePicker renders outside quick menu and switches installed engines', async () => {
  const harness = importedHarnessPromise ?? (importedHarnessPromise = importHarness());
  const { mountCompactControls } = await harness;
  const restore = installDom();
  let mounted;
  try {
    const container = document.getElementById('root');
    const launchedClients = [];
    mounted = mountCompactControls(container, {
      provider: 'claude',
      codexInstalled: true,
      agyInstalled: true,
      opencodeInstalled: false,
      onLaunchNewSession: (client) => launchedClients.push(client),
    });

    const engineTrigger = container.querySelector('[data-testid="composer-engine-trigger"]');
    assert.ok(engineTrigger, 'engine trigger must render outside + menu');
    assert.equal(engineTrigger.querySelector('.sr-only')?.textContent, 'Claude');
    const visibleEngineTexts = [...engineTrigger.querySelectorAll('*')]
      .flatMap((el) => [...el.childNodes])
      .filter((node) => (
        node.nodeType === Node.TEXT_NODE
        && node.textContent.trim().length > 0
        && !node.parentElement?.closest('svg, .sr-only')
      ));
    assert.equal(
      visibleEngineTexts.length,
      0,
      'engine trigger shows icon only without visible label text',
    );
    assert.equal(engineTrigger.querySelectorAll('svg').length, 1);

    await mounted.act(async () => {
      engineTrigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      engineTrigger.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const codexOption = document.querySelector('[data-composer-engine-option="codex"]');
    const agyOption = document.querySelector('[data-composer-engine-option="agy"]');
    const opencodeOption = document.querySelector('[data-composer-engine-option="opencode"]');
    assert.ok(codexOption && agyOption && opencodeOption, 'engine dropdown must render all engines');
    assert.ok(opencodeOption.hasAttribute('data-disabled') || opencodeOption.getAttribute('aria-disabled') === 'true');

    await mounted.act(async () => {
      codexOption.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.deepEqual(launchedClients, ['codex']);

    const quickTrigger = container.querySelector('[data-testid="composer-quick-menu-trigger"]');
    assert.ok(quickTrigger, '+ menu trigger must render');
    await mounted.act(async () => {
      quickTrigger.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    assert.equal(
      document.querySelectorAll('[data-composer-engine-option]').length,
      0,
      'quick menu must no longer contain engine options',
    );
    assert.ok(document.querySelector('[data-testid="composer-quick-attach-files"]'));
    assert.ok(document.querySelector('[data-testid="composer-quick-attach-images"]'));
    assert.ok(document.querySelector('[data-testid="composer-quick-reference-session"]'));
  } finally {
    if (mounted) {
      mounted.unmount();
      await mounted.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    restore();
  }
});

test('ComposerQuickMenu attaches files via open_files_dialog, images via picker input, and inserts session references', async () => {
  const harness = importedHarnessPromise ?? (importedHarnessPromise = importHarness());
  const { mountCompactControls } = await harness;
  const restore = installDom();
  const previousInvoke = globalThis.__acceptanceInvoke;
  let mounted;
  try {
    const invokeCalls = [];
    globalThis.__acceptanceInvoke = async (command, args) => {
      invokeCalls.push({ command, args });
      if (command === 'open_files_dialog') {
        return ['/tmp/project/src/app.ts'];
      }
      return [];
    };

    const draftUpdates = [];
    const container = document.getElementById('root');
    mounted = mountCompactControls(container, {
      provider: 'claude',
      workingDir: '/tmp/project',
      onValueChange: (value) => draftUpdates.push(value),
      sessionReferencesClient: {
        list: async () => [
          { runtime_id: 'rt-design', title: '设计方案', provider: 'claude', can_send: true },
        ],
        read: async () => ({ runtime_id: 'rt-design', title: '设计方案', text: 'context', truncated: false }),
        send: async () => {},
      },
    });

    const quickTrigger = container.querySelector('[data-testid="composer-quick-menu-trigger"]');
    await mounted.act(async () => {
      quickTrigger.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const attachFilesBtn = document.querySelector('[data-testid="composer-quick-attach-files"]');
    assert.ok(attachFilesBtn);
    await mounted.act(async () => {
      attachFilesBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.deepEqual(
      invokeCalls.filter((call) => call.command === 'open_files_dialog'),
      [{ command: 'open_files_dialog', args: { defaultDir: '/tmp/project' } }],
    );
    assert.match(container.textContent, /app\.ts/);

    const imageInput = container.querySelector('[data-testid="composer-image-picker-input"]');
    assert.ok(imageInput, 'hidden image file input must render');
    let imageInputClicked = false;
    imageInput.click = () => { imageInputClicked = true; };
    await mounted.act(async () => {
      quickTrigger.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const attachImagesBtn = document.querySelector('[data-testid="composer-quick-attach-images"]');
    assert.ok(attachImagesBtn);
    await mounted.act(async () => {
      attachImagesBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(imageInputClicked, true, 'clicking attach images must open file input');

    const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const imageFile = new window.File([pngBytes], 'diagram.png', { type: 'image/png' });
    Object.defineProperty(imageInput, 'files', { configurable: true, value: [imageFile] });
    await mounted.act(async () => {
      imageInput.dispatchEvent(new window.Event('change', { bubbles: true }));
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (/diagram\.png/.test(container.textContent)) break;
      }
    });
    assert.match(container.textContent, /diagram\.png/);

    await mounted.act(async () => {
      quickTrigger.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const refTrigger = document.querySelector('[data-testid="composer-quick-reference-session"]');
    assert.ok(refTrigger);
    await mounted.act(async () => {
      refTrigger.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const sessionOption = document.querySelector('[data-composer-session-option="rt-design"]');
    assert.ok(sessionOption, 'session reference picker should list matching project sessions');
    await mounted.act(async () => {
      sessionOption.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.ok(container.querySelector('[data-session-reference-strip]'), 'selecting a session inserts @session chip');
    assert.ok(draftUpdates.some((entry) => entry.includes('ccem-session:rt-design')));
  } finally {
    globalThis.__acceptanceInvoke = previousInvoke;
    if (mounted) {
      mounted.unmount();
      await mounted.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    restore();
  }
});

test('composer footer narrow and compact thresholds are wired through the shared footer row used by every composer surface', async () => {
  const component = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceSessionComposer.tsx'),
    'utf8',
  );
  // Every ComposerControls consumer (workspace home, history, native session
  // view) renders through this single footer row, so the narrow + compact
  // contract has one anchor.
  assert.match(component, /group\/composer-footer/);
  assert.match(component, /data-compact=\{compact \|\| composerFooterCompact \|\| undefined\}/);
  assert.match(component, /data-narrow=\{!compact && !composerFooterCompact && composerFooterNarrow \? '' : undefined\}/);
  const controls = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'ComposerControls.tsx'),
    'utf8',
  );
  const compactOccurrences = controls.match(/group-data-\[compact\]\/composer-footer:hidden/g) ?? [];
  assert.equal(
    compactOccurrences.length,
    4,
    'env name, lock badge, middot, and effort text collapse at data-compact while the gauge glyph remains',
  );
  assert.match(
    controls,
    /group-data-\[narrow\]\/composer-footer:hidden/,
    'effort cluster hides first at data-narrow before compact mode',
  );
});
