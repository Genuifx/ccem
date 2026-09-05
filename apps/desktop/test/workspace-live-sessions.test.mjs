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
  const initialAnnotations = [{
    quote: 'selected code',
    note: 'keep this visible',
  }];

  const first = upsertWorkspaceLiveSessionEntry({}, nativeSession(), {
    initialPrompt: '帮我给工作间会话生成标题',
    initialAnnotations,
  });
  const second = upsertWorkspaceLiveSessionEntry(first, nativeSession(), {
    generatedTitle: '工作间会话标题生成',
  });

  assert.equal(second['native-1'].initialPrompt, '帮我给工作间会话生成标题');
  assert.equal(second['native-1'].initialAnnotations, initialAnnotations);
  assert.equal(second['native-1'].generatedTitle, '工作间会话标题生成');
});

test('reconciles restored runtime truth without erasing live conversation metadata', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const seedMessages = [{ id: 'seed-1', role: 'user', content: 'hello' }];
  const initialAnnotations = [{ quote: 'selected text', note: 'restore this' }];
  const previous = upsertWorkspaceLiveSessionEntry({}, nativeSession(), {
    initialPrompt: '原始提示',
    initialAnnotations,
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
  assert.equal(reconciled['native-1'].initialAnnotations, initialAnnotations);
  assert.equal(reconciled['native-1'].generatedTitle, '已生成标题');
  assert.equal(reconciled['native-1'].seedMessages, seedMessages);
  assert.equal(reconciled['native-1'].session.provider_session_id, 'provider-1');
  assert.equal(reconciled['native-2'].initialPrompt, null);
  assert.equal(reconciled['native-2'].initialAnnotations, null);
  assert.deepEqual(reconciled['native-2'].seedMessages, []);
});

test('reconciles a persisted display title even when no other summary field changes', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const previous = upsertWorkspaceLiveSessionEntry(
    {},
    nativeSession({ display_title: '旧标题' }),
  );

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(previous, [
    nativeSession({ display_title: '首屏加载请求优化' }),
  ]);

  assert.notEqual(reconciled, previous);
  assert.notEqual(reconciled['native-1'], previous['native-1']);
  assert.equal(reconciled['native-1'].session.display_title, '首屏加载请求优化');
});

test('reconciles a restored first user prompt even when no other summary field changes', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const previous = upsertWorkspaceLiveSessionEntry({}, nativeSession({
    initial_user_prompt: null,
  }));

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(previous, [
    nativeSession({ initial_user_prompt: '冷启动恢复出的首条用户消息' }),
  ]);

  assert.notEqual(reconciled, previous);
  assert.notEqual(reconciled['native-1'], previous['native-1']);
  assert.equal(
    reconciled['native-1'].session.initial_user_prompt,
    '冷启动恢复出的首条用户消息',
  );
});

test('a temporary empty summary cannot erase a restored first user prompt', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const restored = upsertWorkspaceLiveSessionEntry({}, nativeSession({
    initial_user_prompt: '已经从事件库恢复的首条用户消息',
  }));
  const temporarilyEmpty = nativeSession({ initial_user_prompt: null });

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(
    restored,
    [temporarilyEmpty],
    restored,
  );
  assert.equal(
    reconciled['native-1'].session.initial_user_prompt,
    '已经从事件库恢复的首条用户消息',
  );

  const refreshedFromGet = upsertWorkspaceLiveSessionEntry(restored, temporarilyEmpty);
  assert.equal(
    refreshedFromGet['native-1'].session.initial_user_prompt,
    '已经从事件库恢复的首条用户消息',
  );
});

test('a stale runtime snapshot still contributes a newly restored first user prompt', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const requestBaseline = upsertWorkspaceLiveSessionEntry({}, nativeSession({
    updated_at: '2026-05-05T10:00:01.000Z',
    initial_user_prompt: null,
  }));
  const current = upsertWorkspaceLiveSessionEntry(requestBaseline, nativeSession({
    status: 'ready',
    updated_at: '2026-05-05T10:00:03.000Z',
    initial_user_prompt: null,
  }));
  const staleRuntimeWithPrompt = nativeSession({
    updated_at: '2026-05-05T10:00:02.000Z',
    initial_user_prompt: '虽然运行状态较旧，但这是新恢复出的首条消息',
  });

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(
    current,
    [staleRuntimeWithPrompt],
    requestBaseline,
  );
  assert.equal(reconciled['native-1'].session.status, 'ready');
  assert.equal(reconciled['native-1'].session.updated_at, '2026-05-05T10:00:03.000Z');
  assert.equal(
    reconciled['native-1'].session.initial_user_prompt,
    '虽然运行状态较旧，但这是新恢复出的首条消息',
  );
});

test('provider binding keeps the runtime first prompt stable', async () => {
  const { upsertWorkspaceLiveSessionEntry } = await importWorkspaceLiveSessions();
  const runtimeFallback = upsertWorkspaceLiveSessionEntry({}, nativeSession({
    provider_session_id: null,
    initial_user_prompt: '本次继续会话时发送的消息',
  }));

  const bound = upsertWorkspaceLiveSessionEntry(runtimeFallback, nativeSession({
    provider_session_id: 'provider-1',
    initial_user_prompt: '不能替换 runtime 首条消息的其他候选',
  }));
  assert.equal(
    bound['native-1'].session.initial_user_prompt,
    '本次继续会话时发送的消息',
  );

  const staleUnbound = upsertWorkspaceLiveSessionEntry(bound, nativeSession({
    provider_session_id: null,
    initial_user_prompt: '迟到的 runtime 继续消息',
  }));
  assert.equal(
    staleUnbound['native-1'].session.initial_user_prompt,
    '本次继续会话时发送的消息',
  );
});

test('patches a snapshot-excluded live title immediately and clears stale generated text', async () => {
  const {
    updateWorkspaceLiveSessionDisplayTitle,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const first = upsertWorkspaceLiveSessionEntry(
    {},
    nativeSession({ provider_session_id: 'provider-1' }),
    { generatedTitle: '旧的自动标题' },
  );
  const previous = upsertWorkspaceLiveSessionEntry(
    first,
    nativeSession({
      runtime_id: 'native-2',
      provider_session_id: 'provider-1',
    }),
    { generatedTitle: '另一个旧自动标题' },
  );

  const renamed = updateWorkspaceLiveSessionDisplayTitle(
    previous,
    'claude',
    'provider-1',
    '手工改名后的标题',
    101,
  );

  assert.equal(renamed['native-1'].session.display_title, '手工改名后的标题');
  assert.equal(renamed['native-1'].generatedTitle, null);
  assert.equal(renamed['native-2'].session.display_title, '手工改名后的标题');
  assert.equal(renamed['native-2'].session.display_title_revision, 101);
  assert.equal(renamed['native-2'].generatedTitle, null);

  const cleared = updateWorkspaceLiveSessionDisplayTitle(
    renamed,
    'claude',
    'provider-1',
    '   ',
    102,
  );
  assert.equal(cleared['native-1'].session.display_title, null);
  assert.equal(cleared['native-1'].generatedTitle, null);
  assert.equal(cleared['native-2'].session.display_title, null);
  assert.equal(cleared['native-2'].session.display_title_revision, 102);
  assert.equal(cleared['native-2'].generatedTitle, null);
});

test('a stale native summary cannot roll back a newer local rename or clear', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    updateWorkspaceLiveSessionDisplayTitle,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const requestBaseline = upsertWorkspaceLiveSessionEntry({}, nativeSession({
    provider_session_id: 'provider-1',
    display_title: '旧标题',
    display_title_revision: 10,
  }));
  const current = updateWorkspaceLiveSessionDisplayTitle(
    requestBaseline,
    'claude',
    'provider-1',
    '',
    12,
  );
  const staleSummary = nativeSession({
    provider_session_id: 'provider-1',
    display_title: '旧标题',
    display_title_revision: 10,
  });

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(
    current,
    [staleSummary],
    requestBaseline,
  );
  assert.equal(reconciled['native-1'].session.display_title, null);
  assert.equal(reconciled['native-1'].session.display_title_revision, 12);

  const refreshedFromStaleGet = upsertWorkspaceLiveSessionEntry(current, staleSummary);
  assert.equal(refreshedFromStaleGet['native-1'].session.display_title, null);
  assert.equal(refreshedFromStaleGet['native-1'].session.display_title_revision, 12);
});

test('provider binding replaces a runtime-key title with authoritative provider title state', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const runtimeTitle = upsertWorkspaceLiveSessionEntry({}, nativeSession({
    display_title: '绑定前 runtime 标题',
    display_title_revision: 20,
  }));
  const boundProviderSummary = nativeSession({
    provider_session_id: 'provider-1',
    display_title: null,
    display_title_revision: 0,
  });

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(
    runtimeTitle,
    [boundProviderSummary],
    runtimeTitle,
  );
  assert.equal(reconciled['native-1'].session.provider_session_id, 'provider-1');
  assert.equal(reconciled['native-1'].session.display_title, null);
  assert.equal(reconciled['native-1'].session.display_title_revision, 0);

  const refreshedFromGet = upsertWorkspaceLiveSessionEntry(runtimeTitle, boundProviderSummary);
  assert.equal(refreshedFromGet['native-1'].session.display_title, null);
  assert.equal(refreshedFromGet['native-1'].session.display_title_revision, 0);
});

test('a stale unbound summary cannot undo provider binding or its title state', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const bound = upsertWorkspaceLiveSessionEntry({}, nativeSession({
    provider_session_id: 'provider-1',
    display_title: '绑定后的手工标题',
    display_title_revision: 20,
  }));
  const staleUnboundSummary = nativeSession({
    provider_session_id: null,
    display_title: '绑定前的 runtime 标题',
    display_title_revision: 10,
  });

  const refreshedFromGet = upsertWorkspaceLiveSessionEntry(bound, staleUnboundSummary);
  assert.equal(refreshedFromGet['native-1'].session.provider_session_id, 'provider-1');
  assert.equal(refreshedFromGet['native-1'].session.display_title, '绑定后的手工标题');
  assert.equal(refreshedFromGet['native-1'].session.display_title_revision, 20);

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(
    bound,
    [staleUnboundSummary],
    bound,
  );
  assert.equal(reconciled['native-1'].session.provider_session_id, 'provider-1');
  assert.equal(reconciled['native-1'].session.display_title, '绑定后的手工标题');
  assert.equal(reconciled['native-1'].session.display_title_revision, 20);
});

test('a newer authoritative clear drops stale generated title metadata', async () => {
  const {
    reconcileWorkspaceLiveSessionsSnapshot,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const previous = upsertWorkspaceLiveSessionEntry(
    {},
    nativeSession({
      provider_session_id: 'provider-1',
      display_title_revision: 0,
    }),
    { generatedTitle: '不应复活的自动标题' },
  );
  const clearedSummary = nativeSession({
    provider_session_id: 'provider-1',
    display_title: null,
    display_title_revision: 40,
  });

  const reconciled = reconcileWorkspaceLiveSessionsSnapshot(
    previous,
    [clearedSummary],
    previous,
  );
  assert.equal(reconciled['native-1'].generatedTitle, null);
  assert.equal(reconciled['native-1'].session.display_title, null);

  const refreshedFromGet = upsertWorkspaceLiveSessionEntry(previous, clearedSummary);
  assert.equal(refreshedFromGet['native-1'].generatedTitle, null);
  assert.equal(refreshedFromGet['native-1'].session.display_title_revision, 40);
});

test('an older rename response cannot roll back a newer optimistic title revision', async () => {
  const {
    updateWorkspaceLiveSessionDisplayTitle,
    upsertWorkspaceLiveSessionEntry,
  } = await importWorkspaceLiveSessions();
  const initial = upsertWorkspaceLiveSessionEntry({}, nativeSession({
    provider_session_id: 'provider-1',
  }));
  const newer = updateWorkspaceLiveSessionDisplayTitle(
    initial,
    'claude',
    'provider-1',
    '较新的手工标题',
    30,
  );
  const stale = updateWorkspaceLiveSessionDisplayTitle(
    newer,
    'claude',
    'provider-1',
    '较旧的手工标题',
    29,
  );

  assert.equal(stale, newer);
  assert.equal(stale['native-1'].session.display_title, '较新的手工标题');
  assert.equal(stale['native-1'].session.display_title_revision, 30);
});

test('manual title edits invalidate an in-flight automatic title generation', async () => {
  const {
    beginWorkspaceSessionTitleGeneration,
    cancelWorkspaceSessionTitleGeneration,
    isWorkspaceSessionTitleGenerationCurrent,
  } = await importWorkspaceLiveSessions();
  const revisions = {};
  const first = beginWorkspaceSessionTitleGeneration(revisions, 'native-1');
  assert.equal(isWorkspaceSessionTitleGenerationCurrent(revisions, 'native-1', first), true);

  cancelWorkspaceSessionTitleGeneration(revisions, 'native-1');
  assert.equal(isWorkspaceSessionTitleGenerationCurrent(revisions, 'native-1', first), false);

  const second = beginWorkspaceSessionTitleGeneration(revisions, 'native-1');
  assert.equal(isWorkspaceSessionTitleGenerationCurrent(revisions, 'native-1', second), true);
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

test('lifecycle-only revisions update, and late same-runtime summaries cannot resurrect ownership', async () => {
  const { upsertWorkspaceLiveSessionEntry, reconcileWorkspaceLiveSessionsSnapshot } = await importWorkspaceLiveSessions();
  const running = nativeSession({ lifecycle: { state_revision: 10, active_command_id: 'A', queue_count: 1 } });
  const initial = upsertWorkspaceLiveSessionEntry({}, running);
  const finished = { ...running, lifecycle: { state_revision: 11, active_command_id: null, queue_count: 0 } };
  const current = upsertWorkspaceLiveSessionEntry(initial, finished);
  assert.notEqual(current, initial);
  assert.equal(current['native-1'].session.lifecycle.active_command_id, null);
  for (const incoming of [running, { ...running, lifecycle: null }]) {
    const upserted = upsertWorkspaceLiveSessionEntry(current, incoming);
    const polled = reconcileWorkspaceLiveSessionsSnapshot(current, [incoming], initial);
    for (const result of [upserted, polled]) {
      assert.equal(result['native-1'].session.lifecycle.state_revision, 11);
      assert.equal(result['native-1'].session.lifecycle.active_command_id, null);
      assert.equal(result['native-1'].session.lifecycle.queue_count, 0);
    }
  }
  const other = upsertWorkspaceLiveSessionEntry(current, { ...running, runtime_id: 'native-2', lifecycle: { state_revision: 1, active_command_id: 'B' } });
  assert.equal(other['native-2'].session.lifecycle.state_revision, 1);
  assert.equal(other['native-2'].session.lifecycle.active_command_id, 'B');
});
