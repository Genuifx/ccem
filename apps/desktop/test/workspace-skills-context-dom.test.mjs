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
let harnessPromise;

test.after(async () => {
  if (harnessPromise) {
    const harness = await harnessPromise;
    await fs.rm(harness.tempDir, { recursive: true, force: true });
  }
  stopEsbuild();
});

function callsLoader(node) {
  let found = false;
  function visit(child) {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)
      && ['loadWorkspaceSkills', 'loadWorkspaceCommands'].includes(child.expression.text)) {
      found = true;
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

async function importHarness() {
  // Execute the production hook statements, including their actual dependency
  // arrays and loader effects. Do not reproduce the memoization in a test model.
  const source = await fs.readFile(path.join(desktopDir, 'src/pages/Workspace.tsx'), 'utf8');
  const ast = ts.createSourceFile('Workspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const workspace = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'Workspace');
  assert.ok(workspace?.body, 'Workspace function must be available to the behavior harness');
  const declarations = new Set(['skillsWorkingDir', 'skillsProvider', 'skillsContext', 'refreshWorkspaceInstalledSkills']);
  const statements = workspace.body.statements.filter((node) => {
    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations.some((declaration) =>
        ts.isIdentifier(declaration.name) && declarations.has(declaration.name.text));
    }
    return ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'useEffect'
      && callsLoader(node);
  });
  assert.ok(statements.length >= 4, 'context, two loader effects and refresh callback must be extracted');
  const productionHooks = statements.map((node) => node.getText(ast)).join('\n');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-skills-context-'));
  const outfile = path.join(tempDir, 'harness.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useCallback, useEffect, useMemo, useState } from 'react';
        import { createRoot } from 'react-dom/client';

        export function mount(container, initial) {
          const installedSkills = [{ name: 'fallback' }];
          const calls = { skills: [], commands: [] };
          const loadWorkspaceSkills = async (context) => {
            calls.skills.push(context);
            return [{ name: 'loaded', ...context }];
          };
          const loadWorkspaceCommands = async (context) => {
            calls.commands.push(context);
            return [{ name: 'command', ...context }];
          };
          let current = initial;
          let snapshot;
          function Harness({ inputs }) {
            const { workspaceMode, selectedSession, activeLiveEntry,
              effectiveComposeDir, composeProvider } = inputs;
            const [workspaceInstalledSkills, setWorkspaceInstalledSkills] = useState([]);
            const [workspaceCommands, setWorkspaceCommands] = useState([]);
            ${productionHooks}
            snapshot = { skillsContext, refreshWorkspaceInstalledSkills,
              workspaceInstalledSkills, workspaceCommands };
            return null;
          }
          const root = createRoot(container);
          return {
            calls,
            snapshot() { return snapshot; },
            async update(patch = {}) {
              current = { ...current, ...patch };
              await act(async () => root.render(<Harness inputs={current} />));
            },
            async refresh() {
              let result;
              await act(async () => { result = await snapshot.refreshWorkspaceInstalledSkills(); });
              return result;
            },
            unmount() { act(() => root.unmount()); },
          };
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'skills-context-harness.tsx',
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    logLevel: 'silent',
  });
  return { ...await import(pathToFileURL(outfile).href), tempDir };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map();
  const expose = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  expose('window', dom.window);
  expose('document', dom.window.document);
  expose('navigator', dom.window.navigator);
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  expose('MessageChannel', class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  });
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

const liveEntry = (overrides = {}) => ({
  session: { runtime_id: 'live-a', project_dir: '/repo/a', provider: 'claude', ...overrides },
});
const historySession = (overrides = {}) => ({ id: 'history-a', project: '/repo/a', source: 'claude', ...overrides });

async function setup(t, initial = {}) {
  const dom = installDom();
  const harness = await (harnessPromise ??= importHarness());
  const mounted = harness.mount(dom.container, {
    workspaceMode: 'live', selectedSession: null, activeLiveEntry: liveEntry(),
    effectiveComposeDir: '/repo/compose', composeProvider: 'codex', ...initial,
  });
  t.after(() => { mounted.unmount(); dom.restore(); });
  await mounted.update();
  return mounted;
}

test('100 live summary/session replacements in one project preserve context, callback and loaders', async (t) => {
  const mounted = await setup(t);
  const first = mounted.snapshot();
  for (let index = 1; index <= 100; index += 1) {
    await mounted.update({
      activeLiveEntry: liveEntry({ runtime_id: `live-${index % 3}`, last_event_seq: index }),
      selectedSession: historySession({ project: `/unused/history-${index}` }),
      effectiveComposeDir: `/unused/compose-${index}`,
      composeProvider: index % 2 ? 'claude' : 'codex',
    });
    assert.equal(mounted.snapshot().skillsContext, first.skillsContext);
    assert.equal(mounted.snapshot().refreshWorkspaceInstalledSkills, first.refreshWorkspaceInstalledSkills);
  }
  assert.equal(mounted.calls.skills.length, 1);
  assert.equal(mounted.calls.commands.length, 1);
});

test('same directory/provider stays stable across history, live and compose transitions', async (t) => {
  const mounted = await setup(t);
  const first = mounted.snapshot();
  await mounted.update({ workspaceMode: 'history', selectedSession: historySession() });
  await mounted.update({ selectedSession: historySession({ id: 'history-b', timestamp: 50 }) });
  await mounted.update({ workspaceMode: 'compose', effectiveComposeDir: '/repo/a', composeProvider: 'claude' });
  await mounted.update({ workspaceMode: 'live', activeLiveEntry: liveEntry({ runtime_id: 'live-b' }) });
  assert.equal(mounted.snapshot().skillsContext, first.skillsContext);
  assert.equal(mounted.snapshot().refreshWorkspaceInstalledSkills, first.refreshWorkspaceInstalledSkills);
  assert.equal(mounted.calls.skills.length, 1);
  assert.equal(mounted.calls.commands.length, 1);
});

test('effective project/provider changes reload both lists and manual refresh uses the newest pair', async (t) => {
  const mounted = await setup(t);
  const first = mounted.snapshot();
  await mounted.update({ activeLiveEntry: liveEntry({ project_dir: '/repo/b' }) });
  assert.notEqual(mounted.snapshot().skillsContext, first.skillsContext);
  assert.equal(mounted.calls.skills.length, 2);
  assert.equal(mounted.calls.commands.length, 2);
  await mounted.update({ activeLiveEntry: liveEntry({ project_dir: '/repo/b', provider: 'codex' }) });
  assert.deepEqual(mounted.calls.skills.at(-1), { workingDir: '/repo/b', provider: 'codex' });
  assert.deepEqual(mounted.calls.commands.at(-1), { workingDir: '/repo/b', provider: 'codex' });
  assert.equal(mounted.calls.skills.length, 3);
  assert.equal(mounted.calls.commands.length, 3);
  const result = await mounted.refresh();
  assert.equal(mounted.calls.skills.length, 4);
  assert.equal(mounted.calls.commands.length, 3);
  assert.deepEqual(result, [{ name: 'loaded', workingDir: '/repo/b', provider: 'codex' }]);
  assert.deepEqual(mounted.snapshot().workspaceInstalledSkills, result);
});

test('history/live selection precedence, source normalization and absent-session fallback are unchanged', async (t) => {
  const mounted = await setup(t, {
    workspaceMode: 'history', selectedSession: historySession({ project: '', source: 'other' }),
  });
  assert.deepEqual(mounted.snapshot().skillsContext, { workingDir: null, provider: 'claude' });
  await mounted.update({ selectedSession: historySession({ project: '/history', source: 'codex' }) });
  assert.deepEqual(mounted.snapshot().skillsContext, { workingDir: '/history', provider: 'codex' });
  await mounted.update({ selectedSession: null });
  assert.deepEqual(mounted.snapshot().skillsContext, { workingDir: '/repo/compose', provider: 'codex' });
  await mounted.update({ workspaceMode: 'live', activeLiveEntry: liveEntry({ project_dir: '', provider: 'opencode' }) });
  assert.deepEqual(mounted.snapshot().skillsContext, { workingDir: null, provider: 'opencode' });
  await mounted.update({ activeLiveEntry: null, effectiveComposeDir: null });
  assert.deepEqual(mounted.snapshot().skillsContext, { workingDir: null, provider: 'codex' });
});
