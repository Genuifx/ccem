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
    builder.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({
      path: 'tauri-window-stub', namespace: 'composer-compact-stubs',
    }));
    builder.onLoad({ filter: /^tauri-window-stub$/, namespace: 'composer-compact-stubs' }, () => ({
      loader: 'js',
      contents: `
        export function getCurrentWindow() {
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
        import { WorkspaceSessionComposer } from '@/components/workspace/WorkspaceSessionComposer';
        import { ComposerControls } from '@/components/workspace/ComposerControls';

        export function mountCompactControls(container) {
          function Harness() {
            return (
              <LocaleProvider>
                <WorkspaceSessionComposer
                value=""
                onValueChange={() => {}}
                onSubmit={() => {}}
                placeholder="composer input"
                canSubmit={false}
                submitLabel="send message"
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
              </LocaleProvider>
            );
          }

          const root = createRoot(container);
          act(() => root.render(<Harness />));

          return {
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
