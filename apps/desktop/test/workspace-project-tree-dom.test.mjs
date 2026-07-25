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
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  for (const filename of INDEX_EXTENSIONS) {
    const candidate = path.join(basePath, filename);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
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
      if (!resolved) {
        return { errors: [{ text: `Could not resolve ${args.path}` }] };
      }
      return { path: resolved };
    });
  },
};

const motionStubPlugin = {
  name: 'ccem-project-tree-motion-stub',
  setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/gsapMotion$/ }, () => ({
      path: 'gsapMotion',
      namespace: 'project-tree-test-stub',
    }));
    builder.onResolve({ filter: /^@\/components\/workspace\/sessionTreeIcons$/ }, () => ({
      path: 'sessionTreeIcons',
      namespace: 'project-tree-test-stub',
    }));
    builder.onLoad(
      { filter: /^gsapMotion$/, namespace: 'project-tree-test-stub' },
      () => ({
        loader: 'js',
        contents: `
          export const ccemMotion = {
            duration: { quick: 0, base: 0, handoff: 0 },
            ease: { standard: 'none', soft: 'none' },
          };
          export const gsap = {
            utils: {
              toArray(selector, root) {
                return Array.from((root || document).querySelectorAll(selector));
              },
            },
            fromTo() {},
            set() {},
          };
          export function shouldReduceMotion() { return true; }
          export function clearMotionProps() {}
        `,
      }),
    );
    builder.onLoad(
      { filter: /^sessionTreeIcons$/, namespace: 'project-tree-test-stub' },
      () => ({
        loader: 'js',
        contents: `
          export function resolveSessionClient(session, decoration) {
            const client = decoration?.client || session.source;
            return client === 'codex' || client === 'opencode' ? client : 'claude';
          }
          export function SessionTreeItemIcon() { return null; }
        `,
      }),
    );
  },
};

async function importProjectTreeHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-project-tree-dom-test-'));
  const outputPath = path.join(tempDir, 'workspace-project-tree-harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useMemo, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { LocaleProvider } from '@/locales';
        import { TooltipProvider } from '@/components/ui/tooltip';
        import { ProjectTree } from '@/components/workspace/ProjectTree';
        import { buildProjectNodes } from '@/components/workspace/workspaceProjectTreeModel';
        import {
          buildLiveSessionTreeState,
          buildWorkspaceSidebarSessions,
        } from '@/components/workspace/workspaceSidebarSessions';

        function ControlledProjectTree({ historySessions, liveEntries, onSelect }) {
          const [selectedKey, setSelectedKey] = useState(null);
          const sidebarSessions = useMemo(
            () => buildWorkspaceSidebarSessions(historySessions, liveEntries),
            [historySessions, liveEntries],
          );
          const projectNodes = useMemo(
            () => buildProjectNodes(historySessions),
            [historySessions],
          );
          const liveTreeState = useMemo(
            () => buildLiveSessionTreeState(liveEntries),
            [liveEntries],
          );

          return (
            <LocaleProvider>
              <TooltipProvider>
                <ProjectTree
                  sessions={sidebarSessions}
                  precomputedProjectNodes={projectNodes}
                  canonicalKeyBySessionKey={liveTreeState.canonicalKeyBySessionKey}
                  activeSessionKeys={liveTreeState.activeSessionKeys}
                  isLoading={false}
                  selectedKey={selectedKey}
                  onSelect={(session) => {
                    setSelectedKey(session.source + ':' + session.id);
                    onSelect(session);
                  }}
                  onRefresh={() => {}}
                />
              </TooltipProvider>
            </LocaleProvider>
          );
        }

        export function mountProjectTree(container, props) {
          const root = createRoot(container);
          const render = (nextProps) => {
            act(() => {
              root.render(<ControlledProjectTree {...nextProps} />);
            });
          };

          render(props);
          return {
            render,
            click(element) {
              act(() => {
                element.click();
              });
            },
            unmount() {
              act(() => {
                root.unmount();
              });
            },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'workspace-project-tree-harness.tsx',
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
    // Animation timing and provider icon internals are outside this test's
    // contract. Their global browser observers otherwise keep node:test alive.
    plugins: [motionStubPlugin, desktopAliasPlugin],
    define: {
      'process.env.NODE_ENV': '"test"',
    },
    logLevel: 'silent',
  });

  return {
    harness: await import(pathToFileURL(outputPath).href),
    tempDir,
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const { window } = dom;
  const scrollCalls = [];

  const expose = (name, value) => {
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
  expose('localStorage', window.localStorage);
  expose('sessionStorage', window.sessionStorage);
  expose('Node', window.Node);
  expose('Element', window.Element);
  expose('HTMLElement', window.HTMLElement);
  expose('SVGElement', window.SVGElement);
  expose('Event', window.Event);
  expose('MouseEvent', window.MouseEvent);
  expose('KeyboardEvent', window.KeyboardEvent);
  expose('CustomEvent', window.CustomEvent);
  expose('MutationObserver', window.MutationObserver);
  expose('DOMRect', window.DOMRect);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('IS_REACT_ACT_ENVIRONMENT', true);

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  const requestAnimationFrame = (callback) => {
    const handle = setTimeout(() => callback(Date.now()), 0);
    handle.unref?.();
    return handle;
  };
  const cancelAnimationFrame = (handle) => clearTimeout(handle);
  const matchMedia = () => ({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  });

  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserver });
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: window.MouseEvent });
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: requestAnimationFrame,
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: cancelAnimationFrame,
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: matchMedia });
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(options) {
      scrollCalls.push({
        key: this.dataset.workspaceSessionKey ?? null,
        options,
      });
    },
  });

  expose('ResizeObserver', ResizeObserver);
  expose('PointerEvent', window.PointerEvent);
  expose('requestAnimationFrame', requestAnimationFrame);
  expose('cancelAnimationFrame', cancelAnimationFrame);
  expose('matchMedia', matchMedia);

  return { dom, scrollCalls };
}

const PROJECT = '/Users/wzt/G/Github/claude-code-env-manager';
const BASE_TIMESTAMP = Date.parse('2026-07-17T12:00:00.000Z');
const FIRST_ACTIVE_PROVIDER_ID = 'active-provider-1';
const SECOND_ACTIVE_PROVIDER_ID = 'active-provider-2';
const MISSING_RUNTIME_ID = 'native-1784217587618';
const MISSING_PROVIDER_ID = '784591d3-62d2-4702-908e-677a934c7f61';
const MISSING_PROVIDER_KEY = `claude:${MISSING_PROVIDER_ID}`;

function historySession({ id, timestamp, display = id }) {
  return {
    id,
    source: 'claude',
    display,
    timestamp,
    project: PROJECT,
    projectName: 'claude-code-env-manager',
    envName: 'DeepSeek',
    configSource: 'ccem',
  };
}

function liveEntry({ runtimeId, providerSessionId, updatedAt, title }) {
  return {
    session: {
      runtime_id: runtimeId,
      provider: 'claude',
      provider_session_id: providerSessionId,
      project_dir: PROJECT,
      env_name: 'DeepSeek',
      status: 'ready',
      is_active: true,
      created_at: updatedAt,
      updated_at: updatedAt,
    },
    generatedTitle: title,
  };
}

function rowsWithKey(root, key) {
  return Array.from(root.querySelectorAll('[data-workspace-session-key]'))
    .filter((element) => element.dataset.workspaceSessionKey === key);
}

test('ProjectTree keeps three ready active rows visible through runtime-to-provider migration', async (t) => {
  const { dom, scrollCalls } = installDom();
  const { harness, tempDir } = await importProjectTreeHarness();
  const container = document.querySelector('#root');
  assert.ok(container);

  let mounted;
  t.after(async () => {
    await mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const ordinarySessions = Array.from({ length: 154 }, (_, index) => historySession({
    id: index === 0
      ? FIRST_ACTIVE_PROVIDER_ID
      : index === 5
        ? SECOND_ACTIVE_PROVIDER_ID
        : `ordinary-${index}`,
    timestamp: BASE_TIMESTAMP - index * 1_000,
  }));
  const initialLiveEntries = [
    liveEntry({
      runtimeId: 'native-active-1',
      providerSessionId: FIRST_ACTIVE_PROVIDER_ID,
      updatedAt: new Date(BASE_TIMESTAMP).toISOString(),
      title: 'active one',
    }),
    liveEntry({
      runtimeId: 'native-active-2',
      providerSessionId: SECOND_ACTIVE_PROVIDER_ID,
      updatedAt: new Date(BASE_TIMESTAMP - 5_000).toISOString(),
      title: 'active two',
    }),
    liveEntry({
      runtimeId: MISSING_RUNTIME_ID,
      providerSessionId: null,
      updatedAt: new Date(BASE_TIMESTAMP - 500).toISOString(),
      title: '修复 workspace 问题',
    }),
  ];
  const selectedSessions = [];

  mounted = await harness.mountProjectTree(container, {
    historySessions: ordinarySessions,
    liveEntries: initialLiveEntries,
    onSelect: (session) => selectedSessions.push(session),
  });

  assert.equal(rowsWithKey(container, `claude:${MISSING_RUNTIME_ID}`).length, 1);

  const providerSession = historySession({
    id: MISSING_PROVIDER_ID,
    display: '修复 workspace 问题',
    timestamp: BASE_TIMESTAMP - 1_000_000,
  });
  const migratedLiveEntries = initialLiveEntries.map((entry) => (
    entry.session.runtime_id === MISSING_RUNTIME_ID
      ? liveEntry({
          runtimeId: MISSING_RUNTIME_ID,
          providerSessionId: MISSING_PROVIDER_ID,
          updatedAt: entry.session.updated_at,
          title: '修复 workspace 问题',
        })
      : entry
  ));
  const migratedHistorySessions = [...ordinarySessions, providerSession];
  assert.equal(migratedHistorySessions.length, 155);
  assert.equal(
    [...migratedHistorySessions].sort((left, right) => right.timestamp - left.timestamp).at(-1).id,
    MISSING_PROVIDER_ID,
  );

  await mounted.render({
    historySessions: migratedHistorySessions,
    liveEntries: migratedLiveEntries,
    onSelect: (session) => selectedSessions.push(session),
  });

  const projectNode = Array.from(container.querySelectorAll('[data-project-motion-key]'))
    .find((element) => element.dataset.projectMotionKey === `project:main:${PROJECT}`);
  assert.ok(projectNode, 'expected the main project node to be rendered');

  const expectedActiveKeys = [
    `claude:${FIRST_ACTIVE_PROVIDER_ID}`,
    `claude:${SECOND_ACTIVE_PROVIDER_ID}`,
    MISSING_PROVIDER_KEY,
  ];
  for (const key of expectedActiveKeys) {
    assert.equal(
      rowsWithKey(projectNode, key).length,
      1,
      `expected active row ${key} exactly once in the same project`,
    );
  }

  assert.equal(rowsWithKey(container, MISSING_PROVIDER_KEY).length, 1);
  assert.equal(rowsWithKey(container, `claude:${MISSING_RUNTIME_ID}`).length, 0);

  const missingProviderRow = rowsWithKey(projectNode, MISSING_PROVIDER_KEY)[0];
  await mounted.click(missingProviderRow);

  assert.equal(selectedSessions.length, 1);
  assert.equal(selectedSessions[0].id, MISSING_PROVIDER_ID);
  assert.equal(selectedSessions[0].source, 'claude');

  const selectedRow = rowsWithKey(projectNode, MISSING_PROVIDER_KEY)[0];
  assert.match(selectedRow.className, /bg-primary\/\[0\.08\]/);
  // The migrated provider row is already visible in the JSDOM viewport, so
  // the scroll-into-view guard intentionally skips scrolling.
  assert.equal(scrollCalls.some((call) => call.key === MISSING_PROVIDER_KEY), false);
});

test('ProjectTree scrolls a selected row into view only when it is outside the viewport', async (t) => {
  const { dom, scrollCalls } = installDom();
  const { harness, tempDir } = await importProjectTreeHarness();
  const container = document.querySelector('#root');
  assert.ok(container);

  let mounted;
  t.after(async () => {
    await mounted?.unmount();
    dom.window.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopEsbuild();
  });

  const sessions = Array.from({ length: 20 }, (_, index) => historySession({
    id: `session-${index}`,
    timestamp: BASE_TIMESTAMP - index * 1_000,
  }));

  mounted = await harness.mountProjectTree(container, {
    historySessions: sessions,
    liveEntries: [],
    onSelect: () => {},
  });

  const projectNode = Array.from(container.querySelectorAll('[data-project-motion-key]'))
    .find((element) => element.dataset.projectMotionKey === `project:main:${PROJECT}`);
  assert.ok(projectNode);

  const rowA = rowsWithKey(projectNode, 'claude:session-0')[0];
  const rowB = rowsWithKey(projectNode, 'claude:session-5')[0];
  assert.ok(rowA);
  assert.ok(rowB);

  // Make the container think every row is fully visible.
  const originalGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this === projectNode || this.contains(projectNode)) {
      return { top: 0, bottom: 400, left: 0, right: 300, width: 300, height: 400 };
    }
    return { top: 10, bottom: 30, left: 0, right: 300, width: 300, height: 20 };
  };

  await mounted.click(rowA);
  assert.equal(scrollCalls.length, 0, 'expected no scroll when target is already visible');

  // Now make the container think the selected row is below the viewport.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this === projectNode || this.contains(projectNode)) {
      return { top: 0, bottom: 100, left: 0, right: 300, width: 300, height: 100 };
    }
    return { top: 150, bottom: 170, left: 0, right: 300, width: 300, height: 20 };
  };

  // Click another row to trigger selection change and scroll-into-view.
  await mounted.click(rowB);
  assert.deepEqual(scrollCalls.at(-1), {
    key: 'claude:session-5',
    options: { block: 'nearest' },
  });

  dom.window.HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});
