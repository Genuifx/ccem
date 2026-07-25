import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWorkspaceSidebarSessions() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceSidebarSessions.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-sidebar-test-'));
  const outputPath = path.join(tempDir, 'workspaceSidebarSessions.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function nativeSession(overrides = {}) {
  return {
    runtime_id: 'native-1',
    provider: 'claude',
    provider_session_id: null,
    project_dir: '/Users/wzt/G/Github/claude-code-env-manager',
    env_name: 'DeepSeek',
    status: 'processing',
    is_active: true,
    created_at: '2026-05-02T12:52:35.000Z',
    updated_at: '2026-05-02T12:52:40.000Z',
    ...overrides,
  };
}

function historySession(overrides = {}) {
  return {
    id: 'history-1',
    source: 'claude',
    display: '历史任务',
    timestamp: Date.parse('2026-05-02T12:53:00.000Z'),
    project: '/Users/wzt/G/Github/claude-code-env-manager',
    projectName: 'claude-code-env-manager',
    envName: 'DeepSeek',
    configSource: 'ccem',
    ...overrides,
  };
}

test('retains workspace history session references when refresh data is unchanged', async () => {
  const { retainStableHistorySessions } = await importWorkspaceSidebarSessions();
  const previous = [
    historySession({ id: 'a', display: 'A' }),
    historySession({ id: 'b', display: 'B', timestamp: Date.parse('2026-05-02T12:52:00.000Z') }),
  ];
  const next = previous.map((session) => ({ ...session }));

  const retained = retainStableHistorySessions(previous, next);

  assert.equal(retained, previous);
  assert.equal(retained[0], previous[0]);
  assert.equal(retained[1], previous[1]);
});

test('retains unchanged workspace history rows across partial refresh changes', async () => {
  const { retainStableHistorySessions } = await importWorkspaceSidebarSessions();
  const previous = [
    historySession({ id: 'a', display: 'A' }),
    historySession({ id: 'b', display: 'B', timestamp: Date.parse('2026-05-02T12:52:00.000Z') }),
  ];
  const changed = {
    ...previous[1],
    taskStage: 'validation',
  };

  const retained = retainStableHistorySessions(previous, [
    { ...previous[0] },
    changed,
  ]);

  assert.notEqual(retained, previous);
  assert.equal(retained[0], previous[0]);
  assert.notEqual(retained[1], previous[1]);
  assert.equal(retained[1].taskStage, 'validation');
});

test('returns the existing history array when no live sidebar sessions are appended', async () => {
  const { buildWorkspaceSidebarSessions } = await importWorkspaceSidebarSessions();
  const history = [
    historySession({ id: 'newer', timestamp: Date.parse('2026-05-02T12:53:00.000Z') }),
    historySession({ id: 'older', timestamp: Date.parse('2026-05-02T12:52:00.000Z') }),
  ];

  const sessions = buildWorkspaceSidebarSessions(history, []);

  assert.equal(sessions, history);
});

test('adds live native sessions to the workspace sidebar before provider history exists', async () => {
  const { buildWorkspaceSidebarSessions } = await importWorkspaceSidebarSessions();

  const sessions = buildWorkspaceSidebarSessions([], [
    {
      session: nativeSession(),
      initialPrompt: '/impeccable craft 工作间的 transcript 渲染',
    },
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'native-1');
  assert.equal(sessions[0].source, 'claude');
  assert.equal(sessions[0].display, '/impeccable craft 工作间的 transcript 渲染');
  assert.equal(sessions[0].projectName, 'claude-code-env-manager');
  assert.equal(sessions[0].envName, 'DeepSeek');
});

test('uses generated live session titles before provider history exists', async () => {
  const { buildWorkspaceSidebarSessions } = await importWorkspaceSidebarSessions();

  const sessions = buildWorkspaceSidebarSessions([], [
    {
      session: nativeSession(),
      initialPrompt: '请帮我排查工作间会话标题生成逻辑，并补测试',
      generatedTitle: '排查工作间标题生成',
    },
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'native-1');
  assert.equal(sessions[0].display, '排查工作间标题生成');
});

test('deduplicates live native sessions after matching provider history appears', async () => {
  const { buildWorkspaceSidebarSessions } = await importWorkspaceSidebarSessions();
  const history = [
    {
      id: 'provider-1',
      source: 'claude',
      display: '历史里的真实标题',
      timestamp: Date.parse('2026-05-02T12:53:00.000Z'),
      project: '/Users/wzt/G/Github/claude-code-env-manager',
      projectName: 'claude-code-env-manager',
      envName: 'DeepSeek',
      configSource: 'ccem',
    },
  ];

  const sessions = buildWorkspaceSidebarSessions(history, [
    {
      session: nativeSession({
        runtime_id: 'native-1',
        provider_session_id: 'provider-1',
        status: 'ready',
      }),
      initialPrompt: '临时标题',
    },
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'provider-1');
  assert.equal(sessions[0].display, '历史里的真实标题');
});

test('resolves review provider session id from a native wrapper history session', async () => {
  const { resolveWorkspaceReviewProviderSessionId } = await importWorkspaceSidebarSessions();

  const session = {
    id: 'native-1781454430199',
    source: 'claude',
    display: '第一性原理多Agent调研',
    timestamp: Date.parse('2026-06-15T12:00:00.000Z'),
    project: '/Users/wzt/G/Github/claude-code-env-manager',
    projectName: 'claude-code-env-manager',
    envName: 'glm-official',
    configSource: 'native',
  };

  const providerSessionId = resolveWorkspaceReviewProviderSessionId(session, {
    session: nativeSession({
      runtime_id: 'native-1781454430199',
      provider_session_id: 'd4465693-907c-4499-840a-106c33f6a967',
      status: 'completed',
    }),
  });

  assert.equal(providerSessionId, 'd4465693-907c-4499-840a-106c33f6a967');
});

test('uses the history id itself for provider history sessions', async () => {
  const { resolveWorkspaceReviewProviderSessionId } = await importWorkspaceSidebarSessions();

  const session = {
    id: 'd4465693-907c-4499-840a-106c33f6a967',
    source: 'claude',
    display: '第一性原理多Agent调研',
    timestamp: Date.parse('2026-06-15T12:00:00.000Z'),
    project: '/Users/wzt/G/Github/claude-code-env-manager',
    projectName: 'claude-code-env-manager',
    envName: 'glm-official',
    configSource: 'ccem',
  };

  assert.equal(resolveWorkspaceReviewProviderSessionId(session, null), session.id);
});

test('omits terminal native sessions from the workspace sidebar', async () => {
  const { buildWorkspaceSidebarSessions } = await importWorkspaceSidebarSessions();

  const sessions = buildWorkspaceSidebarSessions([], [
    {
      session: nativeSession({
        runtime_id: 'native-stopped',
        status: 'stopped',
      }),
      initialPrompt: '已经停止的任务',
    },
    {
      session: nativeSession({
        runtime_id: 'native-running',
        status: 'processing',
        updated_at: '2026-05-02T12:53:00.000Z',
      }),
      initialPrompt: '还在运行的任务',
    },
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'native-running');
  assert.equal(sessions[0].display, '还在运行的任务');
});

test('keeps interrupted native sessions in the workspace sidebar for recovery', async () => {
  const { buildWorkspaceSidebarSessions } = await importWorkspaceSidebarSessions();

  const sessions = buildWorkspaceSidebarSessions([], [
    {
      session: nativeSession({
        runtime_id: 'native-interrupted',
        status: 'interrupted',
      }),
      initialPrompt: '可以恢复输入的任务',
    },
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'native-interrupted');
  assert.equal(sessions[0].display, '可以恢复输入的任务');
});

test('canonicalizes runtime and provider ids to one current project-tree identity', async () => {
  const { buildLiveSessionTreeState } = await importWorkspaceSidebarSessions();

  const state = buildLiveSessionTreeState([
    {
      session: nativeSession({
        runtime_id: 'native-1784217587618',
        provider_session_id: '784591d3-62d2-4702-908e-677a934c7f61',
        status: 'ready',
        is_active: true,
      }),
      initialPrompt: '/lightweight-dev-mode 修复 workspace 的这个问题',
    },
  ]);

  const providerKey = 'claude:784591d3-62d2-4702-908e-677a934c7f61';
  assert.equal(state.canonicalKeyBySessionKey['claude:native-1784217587618'], providerKey);
  assert.equal(state.canonicalKeyBySessionKey[providerKey], providerKey);
  assert.deepEqual([...state.activeSessionKeys], [providerKey]);
});

test('only marks actually active live sessions as project-tree priorities', async () => {
  const { buildLiveSessionTreeState } = await importWorkspaceSidebarSessions();

  const state = buildLiveSessionTreeState([
    {
      session: nativeSession({
        runtime_id: 'native-ready-active',
        provider_session_id: 'provider-ready-active',
        status: 'ready',
        is_active: true,
      }),
    },
    {
      session: nativeSession({
        runtime_id: 'native-processing-inactive',
        provider_session_id: 'provider-processing-inactive',
        status: 'processing',
        is_active: false,
      }),
    },
    {
      session: nativeSession({
        runtime_id: 'native-interrupted',
        provider_session_id: 'provider-interrupted',
        status: 'interrupted',
        is_active: false,
      }),
    },
    {
      session: nativeSession({
        runtime_id: 'native-stopped',
        provider_session_id: 'provider-stopped',
        status: 'stopped',
        is_active: true,
      }),
    },
  ]);

  assert.deepEqual([...state.activeSessionKeys], ['claude:provider-ready-active']);
  assert.equal(
    state.canonicalKeyBySessionKey['claude:native-interrupted'],
    'claude:provider-interrupted'
  );
});

test('discovers every authoritative active native session while restoring only persisted inactive sessions', async () => {
  const { selectWorkspaceLiveSessionsForRestore } = await importWorkspaceSidebarSessions();
  const sessions = [
    nativeSession({ runtime_id: 'active-unpersisted', status: 'ready', is_active: true }),
    nativeSession({ runtime_id: 'active-persisted', status: 'processing', is_active: true }),
    nativeSession({ runtime_id: 'recoverable-persisted', status: 'interrupted', is_active: false }),
    nativeSession({ runtime_id: 'recoverable-unpersisted', status: 'closed_idle', is_active: false }),
    nativeSession({ runtime_id: 'stale-processing', status: 'processing', is_active: false }),
    nativeSession({ runtime_id: 'terminal-persisted', status: 'stopped', is_active: false }),
  ];

  const restored = selectWorkspaceLiveSessionsForRestore(
    sessions,
    ['active-persisted', 'recoverable-persisted', 'terminal-persisted'],
  );

  assert.deepEqual(restored.map((session) => session.runtime_id), [
    'active-unpersisted',
    'active-persisted',
    'recoverable-persisted',
  ]);
});

test('detects local-active and decoration-inactive truth conflicts for reconciliation', async () => {
  const { hasWorkspaceLiveActivityConflict } = await importWorkspaceSidebarSessions();
  const activeSessionKeys = new Set(['claude:provider-active']);

  assert.equal(hasWorkspaceLiveActivityConflict(activeSessionKeys, {
    'claude:provider-active': { isActive: false },
  }), true);
  assert.equal(hasWorkspaceLiveActivityConflict(activeSessionKeys, {
    'claude:provider-active': { isActive: true },
  }), false);
  assert.equal(hasWorkspaceLiveActivityConflict(activeSessionKeys, {}), false);
});
