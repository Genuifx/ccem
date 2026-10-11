import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(__dirname, '..', 'src', 'components', 'workspace');
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

let groupingModulePromise;

function importGrouping() {
  groupingModulePromise ??= (async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-sidebar-grouping-test-'));
    tempDirs.push(tempDir);
    for (const name of ['workspaceProjectTreeModel', 'workspaceSidebarGrouping']) {
      const source = await fs.readFile(path.join(workspaceDir, `${name}.ts`), 'utf8');
      const output = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ES2022,
          target: ts.ScriptTarget.ES2022,
          isolatedModules: true,
        },
      });
      const text = output.outputText.replace(
        /from '\.\/workspaceProjectTreeModel'/g,
        "from './workspaceProjectTreeModel.mjs'",
      );
      await fs.writeFile(path.join(tempDir, `${name}.mjs`), text, 'utf8');
    }
    return import(pathToFileURL(path.join(tempDir, 'workspaceSidebarGrouping.mjs')).href);
  })();
  return groupingModulePromise;
}

const ROOT = '/Users/wzt/G/Github/claude-code-env-manager';
const OTHER = '/Users/wzt/G/Github/other-project';
const COPILOT_WORKTREE = '/Users/wzt/G/Github/copilot-worktrees/claude-code-env-manager/genuifx-psychic-dollop';
const HERMES = '/Users/wzt/.hermes/demand-inbox/executor-state/worktrees/0123456789abcdef0123456789abcdef';

const projectAt = (root, name = path.posix.basename(root)) => ({
  kind: 'project',
  nodeKey: root,
  projectName: name,
  createPath: root,
});

const group = (groupId, extra = {}) => ({
  kind: 'group',
  groupId,
  nodeKey: `ccem-group:${groupId}`,
  projectName: '',
  ...extra,
});

function historySession(overrides = {}) {
  return {
    id: 'session-1',
    source: 'claude',
    display: 'Session',
    timestamp: 1,
    project: ROOT,
    projectName: 'claude-code-env-manager',
    ...overrides,
  };
}

test('agent scratch directories and system temp folders collapse into fixed groups', async () => {
  const { resolveProjectPathOrigins } = await importGrouping();
  const windowsTemp = 'C:\\Users\\wzt\\AppData\\Local\\Temp\\scratch';
  const origins = resolveProjectPathOrigins([
    HERMES,
    '/private/var/folders/xy/abc123/T/tmp.k2j3h4',
    '/tmp/repro-case',
    windowsTemp,
  ]);

  assert.deepStrictEqual(origins.get(HERMES), group('agent', { context: 'Hermes' }));
  assert.deepStrictEqual(origins.get('/private/var/folders/xy/abc123/T/tmp.k2j3h4'), group('temporary'));
  assert.deepStrictEqual(origins.get('/tmp/repro-case'), group('temporary', { context: 'repro-case' }));
  assert.deepStrictEqual(origins.get(windowsTemp), group('temporary', { context: 'scratch' }));
});

test('shared worktrees fold into the repository checkout they belong to', async () => {
  const { resolveProjectPathOrigins } = await importGrouping();
  const codexWorktree = '/Users/wzt/.codex/worktrees/a1b2/claude-code-env-manager';
  const conductorWorkspace = '/Users/wzt/conductor/workspaces/claude-code-env-manager/lisbon';
  const origins = resolveProjectPathOrigins([COPILOT_WORKTREE, codexWorktree, conductorWorkspace, ROOT]);

  assert.deepStrictEqual(origins.get(ROOT), projectAt(ROOT));
  assert.deepStrictEqual(origins.get(COPILOT_WORKTREE), {
    ...projectAt(ROOT),
    kind: 'worktree',
    detail: 'genuifx-psychic-dollop',
  });
  assert.deepStrictEqual(origins.get(codexWorktree), { ...projectAt(ROOT), kind: 'worktree', detail: 'a1b2' });
  assert.deepStrictEqual(origins.get(conductorWorkspace), { ...projectAt(ROOT), kind: 'worktree', detail: 'lisbon' });
});

test('shared worktrees without a known checkout list under a virtual repository node', async () => {
  const { resolveProjectPathOrigins } = await importGrouping();
  const origins = resolveProjectPathOrigins([COPILOT_WORKTREE]);

  assert.deepStrictEqual(origins.get(COPILOT_WORKTREE), {
    kind: 'worktree',
    nodeKey: 'ccem-repo:claude-code-env-manager',
    projectName: 'claude-code-env-manager',
    detail: 'genuifx-psychic-dollop',
  });
});

test('worktrees and tool folders inside a repository attach to it', async () => {
  const { resolveProjectPathOrigins } = await importGrouping();
  const localWorktree = `${ROOT}/.worktrees/ui-mainflow-1782663992`;
  const claudeWorktree = `${ROOT}/.claude/worktrees/feature-x`;
  const artifacts = `${ROOT}/.artifacts/tauri-dev`;
  const unknownParentArtifacts = '/Users/wzt/G/Github/unseen/.artifacts/run';
  const origins = resolveProjectPathOrigins([ROOT, localWorktree, claudeWorktree, artifacts, unknownParentArtifacts]);

  assert.deepStrictEqual(origins.get(localWorktree), {
    ...projectAt(ROOT),
    kind: 'worktree',
    detail: 'ui-mainflow-1782663992',
  });
  assert.deepStrictEqual(origins.get(claudeWorktree), { ...projectAt(ROOT), kind: 'worktree', detail: 'feature-x' });
  assert.deepStrictEqual(origins.get(artifacts), { ...projectAt(ROOT), kind: 'nested', detail: '.artifacts/tauri-dev' });
  // Only folders of a directory that hosted sessions itself are folded.
  assert.deepStrictEqual(origins.get(unknownParentArtifacts), projectAt(unknownParentArtifacts, 'run'));
});

test('home folders are projectless chats, while home dot-folders stay regular projects', async () => {
  const { resolveProjectPathOrigins } = await importGrouping();
  const codexChat = '/Users/wzt/Documents/Codex/2026-06-01/rename-files';
  const origins = resolveProjectPathOrigins([
    '/Users/wzt',
    '/Users/wzt/Desktop',
    '/root',
    '/',
    codexChat,
    '/Users/wzt/.claude',
    '/home/dev/service',
  ]);

  assert.deepStrictEqual(origins.get('/Users/wzt'), group('chat'));
  assert.deepStrictEqual(origins.get('/Users/wzt/Desktop'), group('chat', { context: 'Desktop' }));
  assert.deepStrictEqual(origins.get('/root'), group('chat'));
  assert.deepStrictEqual(origins.get('/'), group('chat'));
  assert.deepStrictEqual(origins.get(codexChat), group('chat', { context: 'rename-files' }));
  assert.deepStrictEqual(origins.get('/Users/wzt/.claude'), projectAt('/Users/wzt/.claude'));
  assert.deepStrictEqual(origins.get('/home/dev/service'), projectAt('/home/dev/service'));
});

test('generated directory names are classified as temporary workspaces', async () => {
  const { resolveProjectPathOrigins } = await importGrouping();
  const hexDir = '/Users/wzt/work/0123456789abcdef01';
  const uuidDir = '/Users/wzt/work/8f14e45f-ceea-467e-a4f3-2b1c9c6a4e2d';
  const origins = resolveProjectPathOrigins([
    '/Users/wzt/G/Github/ui-smoke-test',
    '/Users/wzt/G/Github/improve-20260601-sidebar',
    hexDir,
    uuidDir,
    '/Users/wzt/G/Github/uikit',
  ]);

  assert.deepStrictEqual(
    origins.get('/Users/wzt/G/Github/ui-smoke-test'),
    group('temporary', { context: 'ui-smoke-test' }),
  );
  assert.deepStrictEqual(
    origins.get('/Users/wzt/G/Github/improve-20260601-sidebar'),
    group('temporary', { context: 'improve-20260601-sidebar' }),
  );
  assert.deepStrictEqual(origins.get(hexDir), group('temporary'));
  assert.deepStrictEqual(origins.get(uuidDir), group('temporary'));
  assert.deepStrictEqual(origins.get('/Users/wzt/G/Github/uikit'), projectAt('/Users/wzt/G/Github/uikit'));
});

test('manual overrides win over path rules and propagate from a repository to its worktrees', async () => {
  const { resolveProjectPathOrigins } = await importGrouping();
  const paths = [ROOT, COPILOT_WORKTREE];

  const temporaryRoot = resolveProjectPathOrigins(paths, { [ROOT]: 'temporary' });
  assert.deepStrictEqual(
    temporaryRoot.get(ROOT),
    group('temporary', { context: 'claude-code-env-manager', overrideKey: ROOT }),
  );
  assert.deepStrictEqual(
    temporaryRoot.get(COPILOT_WORKTREE),
    group('temporary', {
      context: 'claude-code-env-manager',
      detail: 'genuifx-psychic-dollop',
      overrideKey: ROOT,
    }),
  );

  const promotedWorktree = resolveProjectPathOrigins(paths, { [COPILOT_WORKTREE]: 'main' });
  assert.deepStrictEqual(promotedWorktree.get(COPILOT_WORKTREE), {
    ...projectAt(COPILOT_WORKTREE),
    overrideKey: COPILOT_WORKTREE,
  });

  const promotedHermes = resolveProjectPathOrigins([HERMES], { [HERMES]: 'main' });
  assert.equal(promotedHermes.get(HERMES).kind, 'project');

  const variantKey = `${ROOT.toLowerCase()}/`;
  const caseInsensitive = resolveProjectPathOrigins(paths, { [variantKey]: 'temporary' });
  assert.equal(caseInsensitive.get(ROOT).overrideKey, variantKey);

  const ignored = resolveProjectPathOrigins(paths, { [ROOT]: 'bogus' });
  assert.deepStrictEqual(ignored.get(ROOT), projectAt(ROOT));
});

test('a virtual repository node can be moved to temporary workspaces', async () => {
  const { resolveProjectPathOrigins } = await importGrouping();
  const overrideKey = 'ccem-repo:claude-code-env-manager';
  const origins = resolveProjectPathOrigins([COPILOT_WORKTREE], { [overrideKey]: 'temporary' });

  assert.deepStrictEqual(
    origins.get(COPILOT_WORKTREE),
    group('temporary', { context: 'claude-code-env-manager', detail: 'genuifx-psychic-dollop', overrideKey }),
  );
});

test('classification does not depend on input order', async () => {
  const { resolveProjectPathOrigins } = await importGrouping();
  const forward = resolveProjectPathOrigins([ROOT, COPILOT_WORKTREE, HERMES]);
  const backward = resolveProjectPathOrigins([HERMES, COPILOT_WORKTREE, ROOT]);

  for (const project of [ROOT, COPILOT_WORKTREE, HERMES]) {
    assert.deepStrictEqual(forward.get(project), backward.get(project));
  }
});

test('the launcher decides before the directory for automated sessions', async () => {
  const {
    canPromoteSessionOrigin,
    isAutomatedSessionOrigin,
    resolveProjectPathOrigins,
    resolveSessionOrigin,
  } = await importGrouping();
  const origins = resolveProjectPathOrigins([ROOT, COPILOT_WORKTREE, HERMES]);

  const scheduled = resolveSessionOrigin({ launchMode: 'cron' }, origins.get(ROOT));
  assert.deepStrictEqual(
    scheduled,
    group('scheduled', { context: 'claude-code-env-manager', byLauncher: true }),
  );
  assert.deepStrictEqual(
    resolveSessionOrigin({ launchMode: 'automation' }, origins.get(ROOT)),
    scheduled,
    'Codex Desktop automation threads join the scheduled group',
  );
  assert.deepStrictEqual(
    resolveSessionOrigin({ launchMode: 'subagent' }, origins.get(ROOT)),
    group('agent', { context: 'claude-code-env-manager', byLauncher: true }),
    'Codex sub-agent and guardian threads join the agent group',
  );

  const controlledWorktree = resolveSessionOrigin({ launchMode: 'external_control' }, origins.get(COPILOT_WORKTREE));
  assert.deepStrictEqual(
    controlledWorktree,
    group('agent', { context: 'claude-code-env-manager', detail: 'genuifx-psychic-dollop', byLauncher: true }),
  );

  const controlledHermes = resolveSessionOrigin({ launchMode: 'external_control' }, origins.get(HERMES));
  assert.deepStrictEqual(controlledHermes, group('agent', { context: 'Hermes', byLauncher: true }));

  const interactive = origins.get(ROOT);
  assert.equal(resolveSessionOrigin({ launchMode: 'native_sdk' }, interactive), interactive);
  assert.equal(resolveSessionOrigin({}, interactive), interactive);

  assert.equal(isAutomatedSessionOrigin(scheduled), true);
  assert.equal(isAutomatedSessionOrigin(origins.get(HERMES)), true);
  assert.equal(isAutomatedSessionOrigin(group('temporary')), false);
  assert.equal(isAutomatedSessionOrigin(interactive), false);

  assert.equal(canPromoteSessionOrigin(interactive), false);
  assert.equal(canPromoteSessionOrigin(origins.get(COPILOT_WORKTREE)), true);
  assert.equal(canPromoteSessionOrigin(origins.get(HERMES)), true);
  assert.equal(canPromoteSessionOrigin(scheduled), false);
});

test('origin labels name the place a session ran', async () => {
  const { describeSessionOrigin, describeSessionOriginInNode, resolveProjectPathOrigins } = await importGrouping();
  const origins = resolveProjectPathOrigins([ROOT, COPILOT_WORKTREE, HERMES, '/Users/wzt']);
  const label = (groupId) => `L:${groupId}`;

  assert.equal(describeSessionOrigin(origins.get(ROOT), label), 'claude-code-env-manager');
  assert.equal(
    describeSessionOrigin(origins.get(COPILOT_WORKTREE), label),
    'claude-code-env-manager · genuifx-psychic-dollop',
  );
  assert.equal(describeSessionOrigin(origins.get(HERMES), label), 'L:agent · Hermes');
  assert.equal(describeSessionOrigin(origins.get('/Users/wzt'), label), 'L:chat');

  assert.equal(describeSessionOriginInNode(origins.get(ROOT)), undefined);
  assert.equal(describeSessionOriginInNode(origins.get(COPILOT_WORKTREE)), 'genuifx-psychic-dollop');
  assert.equal(describeSessionOriginInNode(origins.get(HERMES)), 'Hermes');
  assert.equal(describeSessionOriginInNode(origins.get('/Users/wzt')), undefined);
  assert.equal(
    describeSessionOriginInNode(group('temporary', { context: 'repo', detail: 'wt' })),
    'repo · wt',
  );
});

test('sidebar nodes list projects by activity, then the fixed groups in canonical order', async () => {
  const { groupSidebarSessions, resolveProjectPathOrigins, resolveSessionOrigin } = await importGrouping();
  const sessions = [
    historySession({ id: 'root-old', project: ROOT, projectName: 'ccem', timestamp: 10 }),
    historySession({ id: 'wt-new', project: COPILOT_WORKTREE, projectName: 'genuifx-psychic-dollop', timestamp: 50 }),
    historySession({ id: 'other', project: OTHER, projectName: 'other-project', timestamp: 40 }),
    historySession({ id: 'hermes', project: HERMES, projectName: 'worktree', timestamp: 60 }),
    historySession({ id: 'cron', project: ROOT, projectName: 'ccem', timestamp: 70, launchMode: 'cron' }),
    historySession({ id: 'home', project: '/Users/wzt', projectName: 'wzt', timestamp: 30 }),
    historySession({ id: 'tmp', project: '/private/tmp/abc', projectName: 'abc', timestamp: 20 }),
  ];
  const origins = resolveProjectPathOrigins(sessions.map((session) => session.project));
  const nodes = groupSidebarSessions(
    sessions,
    (session) => resolveSessionOrigin(session, origins.get(session.project)),
  );

  assert.deepStrictEqual(
    nodes.map((node) => [node.project, node.kind, node.groupId ?? null, node.sessions.map((session) => session.id)]),
    [
      [ROOT, 'project', null, ['wt-new', 'root-old']],
      [OTHER, 'project', null, ['other']],
      ['ccem-group:chat', 'group', 'chat', ['home']],
      ['ccem-group:agent', 'group', 'agent', ['hermes']],
      ['ccem-group:scheduled', 'group', 'scheduled', ['cron']],
      ['ccem-group:temporary', 'group', 'temporary', ['tmp']],
    ],
  );
  const rootNode = nodes[0];
  assert.equal(rootNode.projectName, 'ccem');
  assert.equal(rootNode.createPath, ROOT);
  assert.equal(rootNode.latestTimestamp, 50);
});

test('a virtual repository node offers no directory to create sessions in', async () => {
  const { groupSidebarSessions, resolveProjectPathOrigins } = await importGrouping();
  const sessions = [historySession({ id: 'wt', project: COPILOT_WORKTREE, projectName: 'genuifx-psychic-dollop' })];
  const origins = resolveProjectPathOrigins([COPILOT_WORKTREE]);
  const [node] = groupSidebarSessions(sessions, (session) => origins.get(session.project));

  assert.equal(node.project, 'ccem-repo:claude-code-env-manager');
  assert.equal(node.projectName, 'claude-code-env-manager');
  assert.equal(node.kind, 'project');
  assert.equal('createPath' in node, false);
});

test('recent mode keeps running automated sessions on the timeline and moves the rest out', async () => {
  const { partitionRecentSessions, resolveProjectPathOrigins, resolveSessionOrigin } = await importGrouping();
  const sessions = [
    historySession({ id: 'cron', project: ROOT, timestamp: 70, launchMode: 'cron' }),
    historySession({ id: 'hermes-running', project: HERMES, timestamp: 60 }),
    historySession({ id: 'hermes-done', project: HERMES, timestamp: 55 }),
    historySession({ id: 'worktree', project: COPILOT_WORKTREE, timestamp: 50 }),
    historySession({ id: 'scratch', project: '/tmp/scratch', timestamp: 40 }),
  ];
  const origins = resolveProjectPathOrigins(sessions.map((session) => session.project));

  const { timeline, automated } = partitionRecentSessions(
    sessions,
    (session) => resolveSessionOrigin(session, origins.get(session.project)),
    new Set(['hermes-running']),
    (session) => session.id,
  );

  assert.deepStrictEqual(timeline.map((session) => session.id), ['hermes-running', 'worktree', 'scratch']);
  assert.deepStrictEqual(automated.map((session) => session.id), ['cron', 'hermes-done']);
});

test('override updates replace case and slash variants of the same directory', async () => {
  const { findProjectClassificationOverrideKey, updateProjectClassificationOverride } = await importGrouping();
  const previous = { '/Users/wzt/G/Github/App/': 'temporary', '/repo/x': 'main' };

  assert.equal(findProjectClassificationOverrideKey(previous, '/users/wzt/g/github/app'), '/Users/wzt/G/Github/App/');
  assert.equal(findProjectClassificationOverrideKey(previous, '/repo/y'), undefined);

  assert.deepStrictEqual(
    updateProjectClassificationOverride(previous, '/users/wzt/g/github/app', 'main'),
    { '/repo/x': 'main', '/users/wzt/g/github/app': 'main' },
  );
  assert.deepStrictEqual(
    updateProjectClassificationOverride(previous, '/USERS/wzt/G/Github/App', null),
    { '/repo/x': 'main' },
  );
  assert.equal(updateProjectClassificationOverride(previous, '/repo/x', 'main'), previous);
  assert.equal(updateProjectClassificationOverride(previous, '/repo/y', null), previous);
});
