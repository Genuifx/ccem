import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWorkspaceLiveSessions() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceLiveSessions.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-live-sessions-test-'));
  const outputPath = path.join(tempDir, 'workspaceLiveSessions.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-sidebar-live-test-'));
  const outputPath = path.join(tempDir, 'workspaceSidebarSessions.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function nativeSession(overrides = {}) {
  return {
    runtime_id: 'native-1',
    provider: 'claude',
    transport: 'native_sdk',
    provider_session_id: null,
    project_dir: '/Users/wzt/G/Github/claude-code-env-manager',
    env_name: 'DeepSeek',
    perm_mode: 'dev',
    runtime_perm_mode: null,
    effort: 'max',
    status: 'processing',
    created_at: '2026-05-05T10:00:00.000Z',
    updated_at: '2026-05-05T10:00:01.000Z',
    is_active: true,
    last_event_seq: 1,
    can_handoff_to_terminal: true,
    last_error: null,
    ...overrides,
  };
}

test('keeps cold-start live selection visible before React commits state', async () => {
  const {
    updateWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const { toLiveHistorySessionItem } = await importWorkspaceSidebarSessions();

  const liveSessionsRef = { current: {} };
  let scheduledState = null;
  const selectedKey = 'claude:native-1';

  const nextSessions = updateWorkspaceLiveSessionsSnapshot(
    liveSessionsRef,
    (next) => {
      scheduledState = next;
    },
    (previous) => upsertWorkspaceLiveSessionEntry(previous, nativeSession(), {
      initialPrompt: 'hello from composer',
      seedMessages: [],
    }),
  );

  assert.equal(liveSessionsRef.current, nextSessions);
  assert.equal(scheduledState, nextSessions);
  assert.equal(liveSessionsRef.current['native-1'].initialPrompt, 'hello from composer');

  const stillExistsInColdStartSnapshot = Object.values(liveSessionsRef.current)
    .some((entry) => {
      const liveItem = toLiveHistorySessionItem(entry);
      return liveItem ? `${liveItem.source}:${liveItem.id}` === selectedKey : false;
    });
  assert.equal(stillExistsInColdStartSnapshot, true);
});

test('upserts generated titles without losing the original prompt anchor', async () => {
  const { upsertWorkspaceLiveSessionEntry } = await importWorkspaceLiveSessions();

  const first = upsertWorkspaceLiveSessionEntry({}, nativeSession(), {
    initialPrompt: '帮我给工作间会话生成标题',
  });
  const second = upsertWorkspaceLiveSessionEntry(first, nativeSession(), {
    generatedTitle: '工作间会话标题生成',
  });

  assert.equal(second['native-1'].initialPrompt, '帮我给工作间会话生成标题');
  assert.equal(second['native-1'].generatedTitle, '工作间会话标题生成');
});

test('reconciles restored runtime truth without erasing live conversation metadata', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const seedMessages = [{ id: 'seed-1', role: 'user', content: 'hello' }];
  const previous = upsertWorkspaceLiveSessionEntry({}, nativeSession(), {
    initialPrompt: '原始提示',
    generatedTitle: '已生成标题',
    seedMessages,
  });

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(previous, [
    nativeSession({
      provider_session_id: 'provider-1',
      status: 'ready',
      updated_at: '2026-05-05T10:00:05.000Z',
    }),
    nativeSession({
      runtime_id: 'native-2',
      provider_session_id: 'provider-2',
      status: 'ready',
    }),
  ]);

  assert.deepEqual(Object.keys(reconciled), ['native-1', 'native-2']);
  assert.equal(reconciled['native-1'].initialPrompt, '原始提示');
  assert.equal(reconciled['native-1'].generatedTitle, '已生成标题');
  assert.equal(reconciled['native-1'].seedMessages, seedMessages);
  assert.equal(reconciled['native-1'].session.provider_session_id, 'provider-1');
  assert.equal(reconciled['native-2'].initialPrompt, null);
  assert.deepEqual(reconciled['native-2'].seedMessages, []);
});

test('reconcile preserves a live session created while native truth was loading', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const requestBaseline = upsertWorkspaceLiveSessionEntry({}, nativeSession(), {
    initialPrompt: 'existing prompt',
  });
  const current = upsertWorkspaceLiveSessionEntry(
    requestBaseline,
    nativeSession({ runtime_id: 'native-fresh' }),
    {
      initialPrompt: 'created during refresh',
      generatedTitle: 'fresh title',
      seedMessages: [{ id: 'fresh-seed', role: 'user', content: 'new' }],
    },
  );

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(
    current,
    [nativeSession()],
    requestBaseline,
  );

  assert.deepEqual(Object.keys(reconciled), ['native-1', 'native-fresh']);
  assert.equal(reconciled['native-fresh'].initialPrompt, 'created during refresh');
  assert.equal(reconciled['native-fresh'].generatedTitle, 'fresh title');
  assert.equal(reconciled['native-fresh'].seedMessages[0].id, 'fresh-seed');
});

test('reconcile does not roll back a newer event update with an older response', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const requestBaseline = upsertWorkspaceLiveSessionEntry({}, nativeSession(), {
    initialPrompt: 'keep me',
  });
  const current = upsertWorkspaceLiveSessionEntry(
    requestBaseline,
    nativeSession({
      status: 'ready',
      updated_at: '2026-05-05T10:00:10.000Z',
      last_event_seq: 5,
    }),
  );

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(
    current,
    [nativeSession({ updated_at: '2026-05-05T10:00:02.000Z', last_event_seq: 2 })],
    requestBaseline,
  );

  assert.equal(reconciled['native-1'].session.status, 'ready');
  assert.equal(reconciled['native-1'].session.last_event_seq, 5);
  assert.equal(reconciled['native-1'].initialPrompt, 'keep me');
});

test('Workspace applies only the latest native restore without changing selection on refresh', async () => {
  const workspaceSource = await fs.readFile(
    path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'),
    'utf8',
  );

  assert.match(
    workspaceSource,
    /const requestSeq = \+\+nativeSessionRestoreRequestSeqRef\.current;/,
  );
  assert.match(
    workspaceSource,
    /if \(requestSeq !== nativeSessionRestoreRequestSeqRef\.current\) \{\s*return;\s*\}/,
  );
  assert.match(
    workspaceSource,
    /restoreNativeSessions\(\{ restorePersistedSelection: false \}\)/,
  );
  assert.match(
    workspaceSource,
    /hasWorkspaceLiveActivityConflict\([\s\S]*const reconcileNativeActivity = async \(\) =>/,
  );
});
