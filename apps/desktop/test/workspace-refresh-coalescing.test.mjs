import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

// Executes the real Workspace.tsx refresh callbacks (loadConversation,
// refreshWorkspaceData, scheduleWorkspaceRefresh) with only their external
// dependencies stubbed, to pin the background-refresh retry/force contracts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const workspacePath = path.join(desktopDir, 'src', 'pages', 'Workspace.tsx');
const sidebarPath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceSidebarSessions.ts');

function extractVariable(tree, name) {
  let found;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(found, `missing ${name}`);
  return `const ${name} = ${found.initializer.getText(tree)};`;
}

function extractFunction(tree, name) {
  const node = tree.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, `missing ${name}`);
  return node.getText(tree).replace(/^export /, '');
}

async function harness({ loadedVersion = null } = {}) {
  const [workspace, sidebar] = await Promise.all([
    fs.readFile(workspacePath, 'utf8'),
    fs.readFile(sidebarPath, 'utf8'),
  ]);
  const workspaceTree = ts.createSourceFile('Workspace.tsx', workspace, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sidebarTree = ts.createSourceFile('sidebar.ts', sidebar, ts.ScriptTarget.Latest, true);

  const state = { detailCalls: 0, overviewForces: [], messages: ['old transcript'] };
  const oldSession = { id: 'fixture', source: 'claude', timestamp: 1 };
  const newSession = { ...oldSession, timestamp: 2 };
  const timers = new Map();
  let timerId = 0;
  const noop = () => {};
  const context = {
    AbortController,
    console: { error: noop },
    useCallback: (fn) => fn,
    isActive: true,
    t: (x) => x,
    toast: { error: noop },
    WORKSPACE_HISTORY_SESSION_LIMIT: 240,
    sessionsRef: { current: [oldSession] },
    selectedKeyRef: { current: 'claude:fixture' },
    conversationRequestSeqRef: { current: 0 },
    conversationLoadAbortRef: { current: null },
    loadedConversationVersionRef: { current: loadedVersion },
    isLoadingMessagesRef: { current: false },
    refreshRequestSeqRef: { current: 0 },
    pendingRefreshRef: { current: false },
    pendingRefreshForceRef: { current: false },
    refreshTimerRef: { current: null },
    hasLoadedRef: { current: true },
    snapshotSessions: [newSession],
    setMessages: (messages) => { state.messages = messages; },
    setSegments: noop,
    setHistoryEvents: noop,
    setHistoryTranscriptBackfillState: noop,
    setActiveSegment: noop,
    setIsRefreshing: noop,
    setIsLoadingSessions: noop,
    setPrecomputedProjectNodes: noop,
    updateIsLoadingMessages: noop,
    loadNativeHistoryConversation: noop,
    hasNativeHistoryTranscriptMessages: (msgs) => msgs.length > 0,
    detailFailuresLeft: 0,
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  context.fetchWorkspaceOverviewSnapshot = async (_limit, force) => {
    state.overviewForces.push(force);
    return { sessions: context.snapshotSessions, projectNodes: [] };
  };
  context.fetchConversationDetail = async () => {
    state.detailCalls += 1;
    if (context.detailFailuresLeft > 0) {
      context.detailFailuresLeft -= 1;
      throw new Error('injected transient detail failure');
    }
    return { messages: ['new transcript'], segments: [] };
  };
  context.syncSessionState = (sessions) => {
    context.sessionsRef.current = sessions;
    return sessions;
  };

  const code = ts.transpileModule([
    extractFunction(sidebarTree, 'historySessionKey'),
    extractFunction(sidebarTree, 'toLoadedHistorySessionVersion'),
    extractFunction(sidebarTree, 'shouldReloadSelectedHistorySession'),
    'const toSessionKey = historySessionKey;',
    extractVariable(workspaceTree, 'loadConversation'),
    extractVariable(workspaceTree, 'refreshWorkspaceData'),
    extractVariable(workspaceTree, 'scheduleWorkspaceRefresh'),
    'globalThis.api = { loadConversation, refreshWorkspaceData, scheduleWorkspaceRefresh };',
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, context);
  const flushTimers = async () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const fn of pending) fn();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  return { api: context.api, context, state, flushTimers };
}

test('unchanged snapshot after a successful load skips the transcript reload', async () => {
  const h = await harness({ loadedVersion: { key: 'claude:fixture', timestamp: 2 } });
  await h.api.refreshWorkspaceData({ force: true });
  assert.equal(h.state.detailCalls, 0);
});

test('transient transcript failure is retried by the next background refresh', async () => {
  const h = await harness({ loadedVersion: { key: 'claude:fixture', timestamp: 1 } });
  h.context.detailFailuresLeft = 1;
  await h.api.refreshWorkspaceData({ force: true });
  assert.equal(h.state.detailCalls, 1);
  assert.deepEqual(h.state.messages, ['old transcript']);
  await h.api.refreshWorkspaceData({ force: true });
  assert.equal(h.state.detailCalls, 2);
  assert.deepEqual(h.state.messages, ['new transcript']);
  await h.api.refreshWorkspaceData({ force: true });
  assert.equal(h.state.detailCalls, 2, 'settles once the new version committed');
});

test('refresh skipped by a busy transcript load is retried later', async () => {
  const h = await harness({ loadedVersion: { key: 'claude:fixture', timestamp: 1 } });
  h.context.conversationLoadAbortRef.current = { abort() {} };
  await h.api.refreshWorkspaceData({ force: true });
  assert.equal(h.state.detailCalls, 0);
  h.context.conversationLoadAbortRef.current = null;
  await h.api.refreshWorkspaceData({ force: true });
  assert.equal(h.state.detailCalls, 1);
  assert.deepEqual(h.state.messages, ['new transcript']);
});

test('coalesced refresh stays forced when focus follows a session event', async () => {
  const h = await harness();
  h.api.scheduleWorkspaceRefresh(700, true);
  h.api.scheduleWorkspaceRefresh(220, false);
  await h.flushTimers();
  assert.deepEqual(h.state.overviewForces, [true]);
});

test('coalesced refresh stays forced when a session event follows focus', async () => {
  const h = await harness();
  h.api.scheduleWorkspaceRefresh(220, false);
  h.api.scheduleWorkspaceRefresh(700, true);
  await h.flushTimers();
  assert.deepEqual(h.state.overviewForces, [true]);
});

test('focus-only refresh stays non-forced and the force flag resets after firing', async () => {
  const h = await harness();
  h.api.scheduleWorkspaceRefresh(700, true);
  await h.flushTimers();
  h.api.scheduleWorkspaceRefresh(220, false);
  await h.flushTimers();
  assert.deepEqual(h.state.overviewForces, [true, false]);
});
