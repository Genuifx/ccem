import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

test('profile-aware history rows, reads and invalidation keep copied Codex IDs separate', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-profile-history-'));
  const calls = [];
  const pending = [];
  globalThis.__profileHistoryInvoke = (command, args) => {
    calls.push({ command, args });
    return new Promise((resolve) => pending.push(resolve));
  };
  try {
    const outfile = path.join(directory, 'history.mjs');
    await build({
      entryPoints: [path.resolve(import.meta.dirname, '../src/features/conversations/historyData.ts')],
      outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'ipc', setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const invoke = (...args) => globalThis.__profileHistoryInvoke(...args);', loader: 'js' }));
      } }],
    });
    const history = await import(pathToFileURL(outfile).href);
    const shared = { id: 'copied', source: 'codex', project: '/repo', projectName: 'repo', display: 'shared', timestamp: 1, codexIsolated: false };
    const isolated = { ...shared, display: 'isolated', codexIsolated: true };
    const snapshot = history.normalizeWorkspaceOverviewSnapshot({
      sessions: [shared, isolated],
      projectNodes: [{ project: '/repo', projectName: 'repo', sessionKeys: ['codex:isolated:copied', 'codex:copied'], latestTimestamp: 1 }],
      totalSessions: 2, totalProjects: 1,
    });
    assert.deepEqual(snapshot.projectNodes[0].sessions.map((row) => row.display), ['isolated', 'shared']);
    const detail = history.fetchConversationDetail(isolated);
    assert.equal(calls.at(-1).args.codexIsolated, true);
    pending.shift()({ messages: [], segments: [] });
    await detail;

    const oldRequest = history.fetchHistorySessions('codex');
    history.invalidateHistoryCache();
    pending.shift()({ sessions: [shared], diagnostics: [] });
    await oldRequest;
    const newRequest = history.fetchHistorySessions('codex');
    assert.equal(calls.filter((call) => call.command === 'get_conversation_history').length, 2);
    pending.shift()({ sessions: [isolated], diagnostics: [] });
    assert.equal((await newRequest)[0].codexIsolated, true);
  } finally {
    delete globalThis.__profileHistoryInvoke;
    await fs.rm(directory, { recursive: true, force: true });
    stop();
  }
});
