import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const desktopDir = path.resolve(import.meta.dirname, '..');
const nativeViewPath = path.join(desktopDir, 'src/components/workspace/WorkspaceNativeSessionView.tsx');
const temporaryDirs = [];
let harnessPromise;

test.after(async () => {
  await Promise.all(temporaryDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })));
  stopEsbuild();
});

// Keep the exported production bridge, its provider nesting and both memo
// boundaries unchanged. Replace only the heavy content body: these tests
// exercise context propagation rather than native IPC, layout or timers.
function replaceHeavyBody(source) {
  const parsed = ts.createSourceFile(nativeViewPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bodies = [];
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
      && node.name?.text === 'WorkspaceNativeSessionViewContent' && node.body) {
      bodies.push(node.body);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(bodies.length, 1, 'locate the real heavy content body without replacing the context bridge');
  const body = bodies[0];
  // Unrelated heavy-view imports include browser-only icon/theme runtimes.
  // Retain the production React/context imports and the two complete component
  // declarations, rather than emulating their provider or memo behavior here.
  const imports = new Set(['react', './WorkspaceSidePanel', './WorkspaceFileLinkContext']);
  const components = new Set(['WorkspaceNativeSessionView', 'WorkspaceNativeSessionViewContent']);
  const statements = parsed.statements.filter((statement) => (
    ts.isImportDeclaration(statement) && imports.has(statement.moduleSpecifier.text)
  ) || (
    ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some((declaration) => components.has(declaration.name.getText(parsed)))
  ));
  return `import { useContextBodyProbe } from 'session-context-probe';\n${statements.map((statement) => {
    const start = statement.getStart(parsed);
    if (start <= body.pos && statement.end >= body.end) {
      return `${source.slice(start, body.getStart(parsed))}{ return useContextBodyProbe(arguments[0]); }${source.slice(body.end, statement.end)}`;
    }
    return source.slice(start, statement.end);
  }).join('\n')}`;
}

async function importHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-session-context-'));
  temporaryDirs.push(tempDir);
  const outfile = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act } from 'react';
        import { createRoot } from 'react-dom/client';
        import { WorkspaceNativeSessionView } from '@/components/workspace/WorkspaceNativeSessionView';
        import { WorkspaceSidePanelContext } from '@/components/workspace/WorkspaceSidePanel';
        import { WorkspaceFileLinkContext } from '@/components/workspace/WorkspaceFileLinkContext';
        import { probes } from 'session-context-probe';

        export function mount(container, initial) {
          probes.clear();
          const root = createRoot(container);
          let current = initial;
          function render() {
            act(() => root.render(
              <WorkspaceSidePanelContext.Provider value={current.sidePanel}>
                <WorkspaceFileLinkContext.Provider value={current.fileLinks}>
                  {current.views.map((props) =>
                    <WorkspaceNativeSessionView key={props.session.runtime_id} {...props} />)}
                </WorkspaceFileLinkContext.Provider>
              </WorkspaceSidePanelContext.Provider>
            ));
          }
          render();
          return {
            update(next) { current = { ...current, ...next }; render(); },
            counts(id) { const probe = probes.get(id); return { body: probe.body, files: probe.files }; },
            props(id) { return probes.get(id).props; },
            click(selector) { act(() => container.querySelector(selector).click()); },
            unmount() { act(() => root.unmount()); },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'workspace-session-context-harness.tsx',
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    alias: { '@': path.join(desktopDir, 'src') },
    plugins: [{
      name: 'workspace-session-context-probe',
      setup(builder) {
        builder.onLoad({ filter: /WorkspaceNativeSessionView\.tsx$/ }, async () => ({
          contents: replaceHeavyBody(await fs.readFile(nativeViewPath, 'utf8')),
          loader: 'tsx',
          resolveDir: path.dirname(nativeViewPath),
        }));
        builder.onResolve({ filter: /^session-context-probe$/ }, () => ({
          path: 'probe', namespace: 'session-context-test',
        }));
        builder.onLoad({ filter: /^probe$/, namespace: 'session-context-test' }, () => ({
          loader: 'tsx', resolveDir: desktopDir,
          contents: `
            import React, { memo, useState } from 'react';
            import { useWorkspaceSidePanel } from '@/components/workspace/WorkspaceSidePanel';
            import { useWorkspaceFileLinks } from '@/components/workspace/WorkspaceFileLinkContext';
            export const probes = new Map();
            const FileConsumer = memo(function FileConsumer({ runtimeId }) {
              const links = useWorkspaceFileLinks();
              probes.get(runtimeId).files++;
              return <button data-file-owner={runtimeId} data-working-dir={links?.workingDir ?? ''}
                onClick={() => links?.openFile('latest.ts')}>{links?.workingDir ?? 'no-files'}</button>;
            });
            export function useContextBodyProbe(props) {
              const panel = useWorkspaceSidePanel();
              const [localState, setLocalState] = useState(0);
              const id = props.session.runtime_id;
              const probe = probes.get(id) ?? { body: 0, files: 0 };
              probe.body++;
              probe.props = props;
              probes.set(id, probe);
              return <section data-session={id} data-owner={panel?.ownerKey ?? ''}>
                <button data-panel-owner={id} onClick={() => panel?.open('files', 'latest.ts')}>open panel</button>
                <button data-local-state={id} onClick={() => setLocalState(value => value + 1)}>{localState}</button>
                <button data-start-new={id} onClick={props.onStartNew}>start new</button>
                <FileConsumer runtimeId={id} />
              </section>;
            }
          `,
        }));
      },
    }],
    logLevel: 'silent',
  });
  return { ...await import(pathToFileURL(outfile).href), tempDir };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map();
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return {
    container: dom.window.document.getElementById('root'),
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

const NOOP = () => {};
function view(runtimeId, isVisible) {
  return { session: { runtime_id: runtimeId, status: 'ready' }, isVisible,
    onSessionUpdate: NOOP, onStartNew: NOOP };
}

function contexts(owner, calls = []) {
  return {
    sidePanel: { ownerKey: owner, tab: 'files', revision: 1, target: null,
      setTarget: NOOP, close: NOOP, revealBrowser: () => NOOP,
      open: (tab, filePath) => { calls.push({ kind: 'panel', owner, tab, filePath }); return NOOP; } },
    fileLinks: { workingDir: `/fixture/${owner}`,
      openFile: (filePath) => calls.push({ kind: 'file', owner, filePath }) },
  };
}

async function setup(t, initial) {
  const dom = installDom();
  let mounted;
  t.after(() => { mounted?.unmount(); dom.restore(); });
  const harness = await (harnessPromise ??= importHarness());
  mounted = harness.mount(dom.container, initial);
  return { ...dom, mounted };
}

test('hidden bodies and memoized descendants ignore changing outer contexts', async (t) => {
  const initial = contexts('A');
  const views = [view('A', true), view('B', false), view('C', false)];
  const { mounted, container } = await setup(t, { ...initial, views });
  const hiddenB = mounted.counts('B');
  const hiddenC = mounted.counts('C');
  let visible = mounted.counts('A');

  mounted.update({ sidePanel: contexts('A-panel-revision-2').sidePanel });
  assert.deepEqual(mounted.counts('A'), { body: visible.body + 1, files: visible.files });
  assert.equal(container.querySelector('[data-session="A"]').dataset.owner, 'A-panel-revision-2');
  visible = mounted.counts('A');
  mounted.update({ fileLinks: contexts('A-files-revision-2').fileLinks });
  assert.deepEqual(mounted.counts('A'), { body: visible.body, files: visible.files + 1 });
  assert.equal(container.querySelector('[data-file-owner="A"]').dataset.workingDir, '/fixture/A-files-revision-2');

  for (let index = 0; index < 10; index++) mounted.update(contexts(`other-owner-${index}`));
  assert.deepEqual(mounted.counts('B'), hiddenB, 'hidden content is not woken by another owner');
  assert.deepEqual(mounted.counts('C'), hiddenC, 'hidden descendants are insulated too');
  assert.equal(container.querySelector('[data-session="B"]').dataset.owner, '');
  assert.equal(container.querySelector('[data-file-owner="B"]').dataset.workingDir, '');
});

test('reveal receives the current owner and callbacks without remounting local state', async (t) => {
  const calls = [];
  const a = view('A', true);
  const b = view('B', false);
  const { mounted, container } = await setup(t, { ...contexts('A', calls), views: [a, b] });
  mounted.click('[data-local-state="A"]');
  assert.equal(container.querySelector('[data-local-state="A"]').textContent, '1');
  mounted.update({ ...contexts('B', calls), views: [{ ...a, isVisible: false }, { ...b, isVisible: true }] });
  const hidden = mounted.counts('A');
  mounted.update(contexts('B-latest', calls));
  assert.deepEqual(mounted.counts('A'), hidden);

  mounted.update({ ...contexts('A-latest', calls), views: [a, b] });
  assert.equal(container.querySelector('[data-local-state="A"]').textContent, '1', 'hidden session state survives');
  assert.equal(container.querySelector('[data-session="A"]').dataset.owner, 'A-latest');
  assert.equal(container.querySelector('[data-file-owner="A"]').dataset.workingDir, '/fixture/A-latest');
  mounted.click('[data-panel-owner="A"]');
  mounted.click('[data-file-owner="A"]');
  assert.deepEqual(calls, [
    { kind: 'panel', owner: 'A-latest', tab: 'files', filePath: 'latest.ts' },
    { kind: 'file', owner: 'A-latest', filePath: 'latest.ts' },
  ], 'revealed UI calls the new owner, never the previously active owner');
});

test('hidden real prop updates still render and callback props are forwarded intact', async (t) => {
  const clicks = [];
  const first = { ...view('A', false), seedMessages: [], initialImages: [],
    installedSkills: [], workspaceCommands: [], initialPrompt: 'retained draft',
    onStartNew: () => clicks.push('first') };
  const { mounted, container } = await setup(t, { ...contexts('outer'), views: [first] });
  for (const [key, value] of Object.entries(first)) assert.equal(mounted.props('A')[key], value, `${key} forwards by identity`);
  const before = mounted.counts('A');
  const next = { ...first, session: { ...first.session, status: 'processing' }, onStartNew: () => clicks.push('latest') };
  mounted.update({ views: [next] });
  assert.equal(mounted.counts('A').body, before.body + 1, 'memo does not suppress changed session state');
  assert.equal(mounted.props('A').session, next.session);
  assert.equal(container.querySelector('[data-session="A"]').dataset.owner, '');
  mounted.click('[data-start-new="A"]');
  assert.deepEqual(clicks, ['latest']);
});

test('omitted visibility defaults to visible and only explicit false isolates contexts', async (t) => {
  const props = view('A', undefined);
  const { mounted, container } = await setup(t, { ...contexts('first'), views: [props] });
  assert.equal(container.querySelector('[data-session="A"]').dataset.owner, 'first');
  mounted.update(contexts('second'));
  assert.equal(container.querySelector('[data-session="A"]').dataset.owner, 'second');
  mounted.update({ views: [{ ...props, isVisible: false }] });
  assert.equal(container.querySelector('[data-session="A"]').dataset.owner, '');
  mounted.update({ ...contexts('latest'), views: [props] });
  assert.equal(container.querySelector('[data-session="A"]').dataset.owner, 'latest');
  assert.equal(container.querySelector('[data-file-owner="A"]').dataset.workingDir, '/fixture/latest');
});
