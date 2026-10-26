import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function resolveSourcePath(importPath) {
  const basePath = path.join(desktopDir, 'src', importPath.slice(2));
  for (const candidate of [
    ...['', '.ts', '.tsx', '.js', '.json'].map((extension) => `${basePath}${extension}`),
    ...['index.ts', 'index.tsx', 'index.js'].map((file) => path.join(basePath, file)),
  ]) {
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
      return resolved ? { path: resolved } : { errors: [{ text: `Could not resolve ${args.path}` }] };
    });
  },
};

let modulePromise;
function importHarness() {
  modulePromise ??= (async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-todo-next-steps-'));
    const outputPath = path.join(tempDir, 'harness.cjs');
    await build({
      stdin: {
        contents: `
          import React from 'react';
          import { renderToStaticMarkup } from 'react-dom/server';
          import { LocaleProvider } from '@/locales';
          import { TooltipProvider } from '@/components/ui/tooltip';
          import { buildWorkspaceTranscriptItems, WorkspaceTranscriptList } from '@/components/workspace/WorkspaceTranscriptList';
          export * from '@/components/workspace/sessionLineage';
          export * from '@/components/workspace/workspaceNextSteps';
          export { shouldShowWorkspaceTodoList } from '@/components/workspace/WorkspaceTodoList';
          export { buildWorkspaceTranscriptItems };

          function installNodeGlobals() {
            const store = new Map();
            Object.defineProperty(globalThis, 'localStorage', {
              configurable: true,
              value: {
                getItem: (key) => store.get(key) ?? null,
                setItem: (key, value) => store.set(key, String(value)),
                removeItem: (key) => store.delete(key),
                clear: () => store.clear(),
              },
            });
          }

          export function renderTranscript(props) {
            installNodeGlobals();
            return renderToStaticMarkup(React.createElement(LocaleProvider, null,
              React.createElement(TooltipProvider, null,
                React.createElement(WorkspaceTranscriptList, props))));
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
      plugins: [desktopAliasPlugin],
      logLevel: 'silent',
    });
    return import(pathToFileURL(outputPath).href);
  })();
  return modulePromise;
}

function assistant(uuid, content) {
  return { msgType: 'assistant', uuid, content, timestamp: 1, segmentIndex: 0, isCompactBoundary: false };
}

function user(uuid, text) {
  return { msgType: 'user', uuid, content: text, timestamp: 1, segmentIndex: 0, isCompactBoundary: false };
}

function todos(items) {
  const completed = items.filter((item) => item.status === 'completed').length;
  return {
    items: items.map((item, index) => ({ id: `t${index}`, sourceLabel: 'TodoWrite', sourceSeq: index, ...item })),
    completed,
    total: items.length,
    source: 'structured',
    revision: 1,
  };
}

const nextSteps = {
  anchorKey: 'a2',
  suggestions: [
    { title: 'Fix flaky test', prompt: 'Investigate the flaky test in foo.' },
    { title: 'Write docs', prompt: 'Document the API.' },
  ],
};

function actions(started = new Map()) {
  return { startedChildKeys: started, onStartSession: async () => {}, onDoHere: async () => {}, onOpen: () => {} };
}

test('next-step context carries the last request, the reply after it, and todos', async () => {
  const { buildNextStepsContext } = await importHarness();
  const built = buildNextStepsContext([
    user('u0', 'old request'),
    assistant('a0', [{ type: 'text', text: 'old reply' }]),
    user('u1', 'add login'),
    assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    assistant('a2', [{ type: 'text', text: 'Login added; tests still missing.' }]),
  ], todos([{ text: 'Add login', status: 'completed' }, { text: 'Add tests', status: 'pending' }]));
  assert.equal(built.anchorKey, 'a2');
  assert.match(built.context, /add login/);
  assert.match(built.context, /tests still missing/);
  assert.doesNotMatch(built.context, /old reply/);
  assert.match(built.context, /- \[x\] Add login/);
  assert.match(built.context, /- \[ \] Add tests/);
});

test('no context or anchor once the user has spoken after the reply', async () => {
  const { buildNextStepsContext, nextStepsAnchorKey } = await importHarness();
  const messages = [user('u1', 'go'), assistant('a1', [{ type: 'text', text: 'done' }]), user('u2', 'next')];
  assert.equal(buildNextStepsContext(messages, null), null);
  assert.equal(nextStepsAnchorKey(messages), null);
  assert.equal(buildNextStepsContext([user('u1', 'go'), assistant('a1', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }])], null), null);
});

test('todo list shows while running or unfinished and hides once done and idle', async () => {
  const { shouldShowWorkspaceTodoList } = await importHarness();
  const open = todos([{ text: 'A', status: 'completed' }, { text: 'B', status: 'in_progress' }]);
  const done = todos([{ text: 'A', status: 'completed' }]);
  assert.equal(shouldShowWorkspaceTodoList(open, false), true);
  assert.equal(shouldShowWorkspaceTodoList(done, true), true);
  assert.equal(shouldShowWorkspaceTodoList(done, false), false);
  assert.equal(shouldShowWorkspaceTodoList(todos([]), true), false);
  assert.equal(shouldShowWorkspaceTodoList(null, true), false);
});

test('todo card renders at the very tail, after the pending row', async () => {
  const { renderTranscript } = await importHarness();
  const html = renderTranscript({
    messages: [user('u1', 'go'), assistant('a1', [{ type: 'text', text: 'working' }])],
    isAwaitingResponse: true,
    todos: todos([
      { text: 'Check config', status: 'completed' },
      { text: 'Run tests', status: 'in_progress', activeText: 'Running unit tests' },
      { text: 'Report', status: 'pending' },
      { text: 'Deploy', status: 'failed' },
    ]),
    nextSteps,
    nextStepActions: actions(),
  });
  const pendingIndex = html.indexOf('workspace-pending-response');
  const todoIndex = html.indexOf('data-workspace-todo-list');
  assert.ok(pendingIndex > -1 && todoIndex > pendingIndex, 'todo list must follow the pending row');
  for (const status of ['completed', 'in_progress', 'pending', 'failed']) {
    assert.match(html, new RegExp(`data-todo-status="${status}"`));
  }
  assert.match(html, /Running unit tests/);
  assert.match(html, /1\/4/);
  assert.doesNotMatch(html, /data-workspace-next-steps/, 'next steps stay hidden while a turn runs');
});

test('next-steps card renders below the todo card once idle, with per-row state', async () => {
  const { renderTranscript, nextStepSuggestionId } = await importHarness();
  const messages = [user('u1', 'go'), assistant('a2', [{ type: 'text', text: 'done' }])];
  const html = renderTranscript({
    messages,
    todos: todos([{ text: 'A', status: 'pending' }]),
    nextSteps,
    nextStepActions: actions(new Map([[nextStepSuggestionId('a2', 1), ['claude:native-1']]])),
  });
  const todoIndex = html.indexOf('data-workspace-todo-list');
  const stepsIndex = html.indexOf('data-workspace-next-steps');
  assert.ok(todoIndex > -1 && stepsIndex > todoIndex, 'next steps sit below the todo card');
  assert.match(html, /Fix flaky test/);
  assert.match(html, new RegExp(`data-next-step-id="next:a2:0" data-next-step-state="suggested"`));
  assert.match(html, new RegExp(`data-next-step-id="next:a2:1" data-next-step-state="started"`));
  assert.doesNotMatch(html, /glass-card/);

  // The started hint lives inside the action button so no extra label pushes it sideways.
  const startedRow = html.match(/<li[^>]*data-next-step-id="next:a2:1"[\s\S]*?<\/li>/)?.[0] ?? '';
  assert.match(startedRow, /打开/);
  assert.doesNotMatch(startedRow, /已开始/);
  assert.equal((startedRow.match(/<button/g) ?? []).length, 1, 'started row exposes a single Open action');

  const empty = renderTranscript({ messages, nextSteps: { anchorKey: 'a2', suggestions: [] }, nextStepActions: actions() });
  assert.doesNotMatch(empty, /data-workspace-next-steps/);
});

test('nests children (and grandchildren) under a present parent and survives cycles', async () => {
  const { nestSessionsByParent, childKeysByProposalId } = await importHarness();
  const parents = { c1: 'p', c2: 'p', g1: 'c1', orphan: 'missing', x: 'y', y: 'x' };
  const rows = nestSessionsByParent(
    ['c1', 'p', 'orphan', 'g1', 'c2', 'x', 'y'],
    (key) => key,
    (key) => parents[key] ?? null,
  );
  assert.deepEqual(rows.map((row) => `${row.session}:${row.depth}`), [
    'p:0', 'c1:1', 'g1:1', 'c2:1', 'orphan:0', 'x:0', 'y:1',
  ]);

  const map = childKeysByProposalId([
    { childKey: 'claude:native-1', parentKey: 'claude:p', proposalId: 'next:a:0' },
    { childKey: 'claude:provider-1', parentKey: 'claude:p', proposalId: 'next:a:0' },
    { childKey: 'claude:other', parentKey: 'claude:p', proposalId: null },
  ]);
  assert.deepEqual([...map.entries()], [['next:a:0', ['claude:native-1', 'claude:provider-1']]]);
});
