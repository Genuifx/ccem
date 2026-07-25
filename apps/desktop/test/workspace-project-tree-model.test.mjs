import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWorkspaceProjectTreeModel() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceProjectTreeModel.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-project-tree-model-test-'));
  const outputPath = path.join(tempDir, 'workspaceProjectTreeModel.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function historySession(overrides = {}) {
  return {
    id: 'session-1',
    source: 'codex',
    display: 'Review the git diff',
    timestamp: Date.parse('2026-06-30T12:00:00.000Z'),
    project: '/Users/wzt/G/Github/claude-code-env-manager',
    projectName: 'claude-code-env-manager',
    envName: 'DeepSeek',
    configSource: 'ccem',
    ...overrides,
  };
}

test('classifies nested git worktree projects as temporary and preserves their parent', async () => {
  const { classifyProject } = await importWorkspaceProjectTreeModel();
  const mainProject = '/Users/wzt/G/Github/claude-code-env-manager';
  const worktree = `${mainProject}/.worktrees/ui-mainflow-1782663992`;

  const classification = classifyProject(worktree, [mainProject, worktree]);

  assert.equal(classification.bucket, 'temporary');
  assert.equal(classification.source, 'worktree');
  assert.equal(classification.parentProject, mainProject);
  assert.equal(classification.parentProjectName, 'claude-code-env-manager');
});

test('manual project classification overrides automatic worktree detection', async () => {
  const { classifyProject } = await importWorkspaceProjectTreeModel();
  const mainProject = '/Users/wzt/G/Github/claude-code-env-manager';
  const worktree = `${mainProject}/.worktrees/e2e-checkpoint-repo`;

  const classification = classifyProject(worktree, [mainProject, worktree], {
    [worktree]: 'main',
  });

  assert.equal(classification.bucket, 'main');
  assert.equal(classification.source, 'manual');
});

test('stable project order keeps existing rows in place and appends new projects', async () => {
  const { reconcileProjectOrder } = await importWorkspaceProjectTreeModel();
  const previous = ['/repo/a', '/repo/b'];
  const latestActivityOrder = ['/repo/b', '/repo/c', '/repo/a'];

  const next = reconcileProjectOrder(previous, latestActivityOrder);

  assert.deepEqual(next, ['/repo/a', '/repo/b', '/repo/c']);
});

test('organize order can still use current activity order explicitly', async () => {
  const { buildProjectNodes } = await importWorkspaceProjectTreeModel();
  const sessions = [
    historySession({
      id: 'old',
      project: '/repo/old',
      projectName: 'old',
      timestamp: Date.parse('2026-06-30T11:00:00.000Z'),
    }),
    historySession({
      id: 'new',
      project: '/repo/new',
      projectName: 'new',
      timestamp: Date.parse('2026-06-30T13:00:00.000Z'),
    }),
  ];

  const activityOrder = buildProjectNodes(sessions).map((node) => node.project);

  assert.deepEqual(activityOrder, ['/repo/new', '/repo/old']);
});

test('stabilizes project sessions when runtime updates reshuffle timestamps', async () => {
  const { stabilizeProjectNodeSessions } = await importWorkspaceProjectTreeModel();
  const previousNodes = [
    {
      project: '/repo/app',
      projectName: 'app',
      latestTimestamp: 3,
      sessions: [
        historySession({ id: 'first', project: '/repo/app', projectName: 'app', timestamp: 3 }),
        historySession({ id: 'second', project: '/repo/app', projectName: 'app', timestamp: 2 }),
        historySession({ id: 'third', project: '/repo/app', projectName: 'app', timestamp: 1 }),
      ],
    },
  ];
  const nextNodes = [
    {
      project: '/repo/app',
      projectName: 'app',
      latestTimestamp: 10,
      sessions: [
        historySession({ id: 'third', project: '/repo/app', projectName: 'app', timestamp: 10 }),
        historySession({ id: 'first', project: '/repo/app', projectName: 'app', timestamp: 3 }),
        historySession({ id: 'second', project: '/repo/app', projectName: 'app', timestamp: 2 }),
      ],
    },
  ];

  const stable = stabilizeProjectNodeSessions(previousNodes, nextNodes);

  assert.deepEqual(stable[0].sessions.map((session) => session.id), ['first', 'second', 'third']);
  assert.equal(stable[0].sessions[2].timestamp, 10);
});

test('stabilized project sessions place fresh sessions before retained rows', async () => {
  const { stabilizeProjectNodeSessions } = await importWorkspaceProjectTreeModel();
  const previousNodes = [
    {
      project: '/repo/app',
      projectName: 'app',
      latestTimestamp: 3,
      sessions: [
        historySession({ id: 'first', project: '/repo/app', projectName: 'app', timestamp: 3 }),
        historySession({ id: 'second', project: '/repo/app', projectName: 'app', timestamp: 2 }),
      ],
    },
  ];
  const nextNodes = [
    {
      project: '/repo/app',
      projectName: 'app',
      latestTimestamp: 4,
      sessions: [
        historySession({ id: 'fresh', project: '/repo/app', projectName: 'app', timestamp: 4 }),
        historySession({ id: 'second', project: '/repo/app', projectName: 'app', timestamp: 2 }),
        historySession({ id: 'first', project: '/repo/app', projectName: 'app', timestamp: 3 }),
      ],
    },
  ];

  const stable = stabilizeProjectNodeSessions(previousNodes, nextNodes);

  assert.deepEqual(stable[0].sessions.map((session) => session.id), ['fresh', 'first', 'second']);
});

test('stabilized project sessions append backfilled sessions behind retained rows', async () => {
  const { stabilizeProjectNodeSessions } = await importWorkspaceProjectTreeModel();
  const previousNodes = [
    {
      project: '/repo/app',
      projectName: 'app',
      latestTimestamp: 3,
      sessions: [
        historySession({ id: 'first', project: '/repo/app', projectName: 'app', timestamp: 3 }),
        historySession({ id: 'active', project: '/repo/app', projectName: 'app', timestamp: 2 }),
      ],
    },
  ];
  const nextNodes = [
    {
      project: '/repo/app',
      projectName: 'app',
      latestTimestamp: 10,
      sessions: [
        historySession({ id: 'active', project: '/repo/app', projectName: 'app', timestamp: 10 }),
        historySession({ id: 'backfill', project: '/repo/app', projectName: 'app', timestamp: 4 }),
        historySession({ id: 'first', project: '/repo/app', projectName: 'app', timestamp: 3 }),
      ],
    },
  ];

  const stable = stabilizeProjectNodeSessions(previousNodes, nextNodes);

  assert.deepEqual(stable[0].sessions.map((session) => session.id), ['first', 'active', 'backfill']);
});

test('runtime to provider identity migration keeps its prior slot among 155 sessions', async () => {
  const { stabilizeProjectNodeSessions } = await importWorkspaceProjectTreeModel();
  const project = '/repo/app';
  const ordinary = Array.from({ length: 154 }, (_, index) => historySession({
    id: `ordinary-${index}`,
    source: 'claude',
    project,
    projectName: 'app',
    timestamp: 10_000 - index,
  }));
  const runtimeSession = historySession({
    id: 'native-1784217587618',
    source: 'claude',
    project,
    projectName: 'app',
    timestamp: 9_999.5,
  });
  const previousSessions = [ordinary[0], runtimeSession, ...ordinary.slice(1)];
  const providerSession = historySession({
    id: '784591d3-62d2-4702-908e-677a934c7f61',
    source: 'claude',
    project,
    projectName: 'app',
    timestamp: 1,
  });
  const nextSessions = [...ordinary, providerSession];
  const canonicalKeyBySessionKey = {
    'claude:native-1784217587618': 'claude:784591d3-62d2-4702-908e-677a934c7f61',
    'claude:784591d3-62d2-4702-908e-677a934c7f61': 'claude:784591d3-62d2-4702-908e-677a934c7f61',
  };

  const stable = stabilizeProjectNodeSessions(
    [{ project, projectName: 'app', latestTimestamp: 10_000, sessions: previousSessions }],
    [{ project, projectName: 'app', latestTimestamp: 10_000, sessions: nextSessions }],
    { canonicalKeyBySessionKey },
  );

  assert.equal(stable[0].sessions.length, 155);
  assert.equal(stable[0].sessions[1].id, providerSession.id);
  assert.equal(stable[0].sessions.some((session) => session.id === runtimeSession.id), false);
  assert.deepEqual(
    stable[0].sessions.filter((session) => session.id.startsWith('ordinary-')).map((session) => session.id),
    ordinary.map((session) => session.id),
  );
});

test('project session window keeps all active rows visible without expanding to hidden indexes', async () => {
  const { selectVisibleProjectSessions } = await importWorkspaceProjectTreeModel();
  const sessions = Array.from({ length: 155 }, (_, index) => historySession({
    id: `session-${index}`,
    source: 'claude',
    timestamp: 1_000 - index,
  }));
  const activeSessionKeys = new Set([
    'claude:session-0',
    'claude:session-5',
    'claude:session-154',
  ]);

  const visible = selectVisibleProjectSessions(sessions, 6, activeSessionKeys);

  assert.equal(visible.length, 7);
  assert.deepEqual(visible.map((session) => session.id), [
    'session-0',
    'session-1',
    'session-2',
    'session-3',
    'session-4',
    'session-5',
    'session-154',
  ]);
  assert.equal(new Set(visible.map((session) => session.id)).size, visible.length);
});

test('project session window shows every active row when active count exceeds page budget', async () => {
  const { selectVisibleProjectSessions } = await importWorkspaceProjectTreeModel();
  const sessions = Array.from({ length: 12 }, (_, index) => historySession({
    id: `session-${index}`,
    timestamp: 1_000 - index,
  }));
  const activeSessionKeys = new Set(
    sessions.slice(5).map((session) => `${session.source}:${session.id}`)
  );

  const visible = selectVisibleProjectSessions(sessions, 6, activeSessionKeys);

  assert.equal(visible.length, 12);
  assert.deepEqual(visible.map((session) => session.id), sessions.map((session) => session.id));
});

test('project session window resolves a stale runtime selection to its provider row', async () => {
  const { selectVisibleProjectSessions } = await importWorkspaceProjectTreeModel();
  const sessions = Array.from({ length: 12 }, (_, index) => historySession({
    id: index === 11 ? 'provider-1' : `session-${index}`,
    source: 'claude',
    timestamp: 1_000 - index,
  }));
  const canonicalKeyBySessionKey = {
    'claude:native-1': 'claude:provider-1',
    'claude:provider-1': 'claude:provider-1',
  };

  const visible = selectVisibleProjectSessions(
    sessions,
    6,
    new Set(['claude:native-1']),
    canonicalKeyBySessionKey,
  );

  assert.equal(visible.some((session) => session.id === 'provider-1'), true);
  assert.equal(visible[0].id, 'session-0');
  assert.equal(visible.length, 7);
});

test('project session window preserves active visibility across load-more and collapse budgets', async () => {
  const { selectVisibleProjectSessions } = await importWorkspaceProjectTreeModel();
  const sessions = Array.from({ length: 20 }, (_, index) => historySession({
    id: `session-${index}`,
    source: 'claude',
    timestamp: 1_000 - index,
  }));
  const activeSessionKeys = new Set(['claude:session-19']);

  const collapsed = selectVisibleProjectSessions(sessions, 6, activeSessionKeys);
  const expanded = selectVisibleProjectSessions(sessions, 12, activeSessionKeys);
  const collapsedAgain = selectVisibleProjectSessions(sessions, 6, activeSessionKeys);

  assert.equal(collapsed.some((session) => session.id === 'session-19'), true);
  assert.equal(expanded.some((session) => session.id === 'session-19'), true);
  assert.equal(collapsedAgain.some((session) => session.id === 'session-19'), true);
  assert.equal(collapsed.length, 7);
  assert.equal(expanded.length, 13);
  assert.deepEqual(collapsedAgain.map((session) => session.id), collapsed.map((session) => session.id));
});

test('project session window caps priority overflow to one extra page', async () => {
  const { selectVisibleProjectSessions } = await importWorkspaceProjectTreeModel();
  const sessions = Array.from({ length: 30 }, (_, index) => historySession({
    id: `session-${index}`,
    source: 'claude',
    timestamp: 1_000 - index,
  }));
  const activeSessionKeys = new Set([
    'claude:session-0',
    'claude:session-5',
    'claude:session-10',
    'claude:session-15',
    'claude:session-20',
    'claude:session-25',
    'claude:session-26',
    'claude:session-27',
    'claude:session-28',
    'claude:session-29',
  ]);

  const visible = selectVisibleProjectSessions(sessions, 6, activeSessionKeys);

  // 6 base + 6 overflow = 12 max. Ordinary sessions 6/7 are squeezed out by
  // priority overflow; the last priorities at indices 28/29 are dropped.
  assert.equal(visible.length, 12);
  assert.deepEqual(visible.map((session) => session.id), [
    'session-0',
    'session-1',
    'session-2',
    'session-3',
    'session-4',
    'session-5',
    'session-10',
    'session-15',
    'session-20',
    'session-25',
    'session-26',
    'session-27',
  ]);
});

test('project priorities combine true live activity with urgent runtime decorations only', async () => {
  const { buildProjectPrioritySessionKeys } = await importWorkspaceProjectTreeModel();
  const canonicalKeyBySessionKey = {
    'claude:native-ready': 'claude:provider-ready',
    'claude:provider-ready': 'claude:provider-ready',
  };

  const priorities = buildProjectPrioritySessionKeys(
    new Set(['claude:native-ready']),
    {
      'claude:provider-ready': { visualState: 'identity' },
      'codex:external-processing': { visualState: 'processing' },
      'claude:external-attention': { visualState: 'attention' },
      'claude:inactive-history': { visualState: 'identity' },
    },
    canonicalKeyBySessionKey,
  );

  assert.deepEqual([...priorities], [
    'claude:provider-ready',
    'codex:external-processing',
    'claude:external-attention',
  ]);
});

test('project priorities honor decoration isActive truth before visual status', async () => {
  const { buildProjectPrioritySessionKeys } = await importWorkspaceProjectTreeModel();

  const priorities = buildProjectPrioritySessionKeys(
    new Set(),
    {
      'claude:ready-active': { visualState: 'identity', isActive: true },
      'claude:stale-processing': { visualState: 'processing', isActive: false },
      'claude:stale-attention': { visualState: 'attention', isActive: false },
      'codex:legacy-processing': { visualState: 'processing' },
    },
  );

  assert.deepEqual([...priorities], [
    'claude:ready-active',
    'codex:legacy-processing',
  ]);
});

test('fresh local activity is not hidden by an independently sampled inactive decoration', async () => {
  const { buildProjectPrioritySessionKeys } = await importWorkspaceProjectTreeModel();

  const priorities = buildProjectPrioritySessionKeys(
    new Set(['claude:stale']),
    {
      'claude:stale': { visualState: 'processing', isActive: false },
    },
  );

  assert.deepEqual([...priorities], ['claude:stale']);
});

test('keeps active temporary projects in the fixed strip until dismissed', async () => {
  const { splitProjectNodesForSidebar } = await importWorkspaceProjectTreeModel();
  const mainNode = {
    project: '/repo/main',
    projectName: 'main',
    latestTimestamp: 2,
    sessions: [historySession({ project: '/repo/main', projectName: 'main' })],
  };
  const temporaryNode = {
    project: '/repo/main/.worktrees/ui-mainflow-123',
    projectName: 'ui-mainflow-123',
    latestTimestamp: 1,
    sessions: [historySession({
      id: 'active-temp',
      project: '/repo/main/.worktrees/ui-mainflow-123',
      projectName: 'ui-mainflow-123',
    })],
  };
  const classificationsByProject = {
    [mainNode.project]: {
      project: mainNode.project,
      bucket: 'main',
      source: 'regular',
    },
    [temporaryNode.project]: {
      project: temporaryNode.project,
      bucket: 'temporary',
      source: 'worktree',
      parentProject: mainNode.project,
      parentProjectName: mainNode.projectName,
    },
  };

  const fixed = splitProjectNodesForSidebar(
    [mainNode, temporaryNode],
    classificationsByProject,
    new Set([temporaryNode.project]),
    new Set()
  );

  assert.deepEqual(fixed.mainProjectNodes.map((node) => node.project), [mainNode.project]);
  assert.deepEqual(fixed.activeTemporaryProjectNodes.map((node) => node.project), [temporaryNode.project]);
  assert.deepEqual(fixed.temporaryProjectNodes, []);

  const dismissed = splitProjectNodesForSidebar(
    [mainNode, temporaryNode],
    classificationsByProject,
    new Set([temporaryNode.project]),
    new Set([temporaryNode.project])
  );

  assert.deepEqual(dismissed.activeTemporaryProjectNodes, []);
  assert.deepEqual(dismissed.temporaryProjectNodes.map((node) => node.project), [temporaryNode.project]);
});
