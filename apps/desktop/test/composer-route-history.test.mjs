import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importModule(relativePath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-route-history-test-'));
  const transpileQueue = [[relativePath, null]];
  const entryPath = path.join(tempDir, path.basename(relativePath).replace(/\.ts$/, '.mjs'));
  const seen = new Set();

  while (transpileQueue.length > 0) {
    const [current] = transpileQueue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const sourcePath = path.join(desktopDir, current);
    const source = await fs.readFile(sourcePath, 'utf8');
    let output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
      },
    }).outputText;
    const currentDir = path.dirname(current);
    const coreBrowserUrl = pathToFileURL(
      path.join(desktopDir, '..', '..', 'packages', 'core', 'dist', 'browser.js'),
    ).href;
    output = output.replace(/from '([^']+)'/g, (_match, spec) => {
      if (spec === '@ccem/core/browser') return `from '${coreBrowserUrl}'`;
      if (spec.startsWith('@ccem/')) return `from '${spec}'`;
      let depRelative;
      if (spec.startsWith('@/')) {
        depRelative = path.join('src', spec.slice(2));
      } else if (spec.startsWith('./') || spec.startsWith('../')) {
        depRelative = path.join(currentDir, spec);
      } else {
        return `from '${spec}'`;
      }
      if (!/\.mjs$/.test(depRelative)) depRelative += '.ts';
      transpileQueue.push([depRelative, null]);
      const depName = depRelative.replace(/[\\/]/g, '__').replace(/\.ts$/, '') + '.mjs';
      return `from './${depName}'`;
    });
    const outName = current === relativePath
      ? path.basename(entryPath)
      : current.replace(/[\\/]/g, '__').replace(/\.ts$/, '.mjs');
    await fs.writeFile(path.join(tempDir, outName), output, 'utf8');
  }
  return import(pathToFileURL(entryPath).href);
}

const MY_DEFAULT = 'my-default';

function routerConfig() {
  return {
    port: 17820,
    dynamicRouting: true,
    bindings: { 'subagent:Explore': 'DeepSeek-V4-Flash' },
    defaultAllowedEnvs: ['GLM-5.3', 'DeepSeek-V4-Flash'],
    profiles: [
      { id: 'profile-a', name: '方案A', revision: 3, bindings: { 'subagent:Explore': 'kiro-rs' }, allowedEnvs: ['GLM-5.3', 'kiro-rs'] },
    ],
  };
}

function routedSummary(overrides = {}) {
  return {
    runtime_id: 'native-restore-1',
    provider: 'claude',
    router: {
      launchTransport: 'routed',
      bindings: { 'subagent:Explore': 'DeepSeek-V4-Flash' },
      defaultEnv: 'GLM-5.3',
      allowedEnvs: ['GLM-5.3', 'DeepSeek-V4-Flash'],
      sourceProfileId: MY_DEFAULT,
      profileRevision: null,
      ...overrides,
    },
  };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    snapshot: () => Object.fromEntries(map),
  };
}

test('restore resolver: routed summary restores an exact runtime reference', async () => {
  const m = await importModule('src/components/workspace/composerRouteDraft.ts');
  const result = m.resolveHistoryRouteRestore(routedSummary());
  assert.equal(result.kind, 'restored');
  assert.deepEqual(result.draft, {
    optIn: true,
    profileId: null,
    restoredSource: {
      runtimeId: 'native-restore-1',
      sourceProfileId: MY_DEFAULT,
      profileRevision: null,
      isDefaultOnly: false,
    },
  });
});

test('restore resolver: direct / null / missing router stay off', async () => {
  const m = await importModule('src/components/workspace/composerRouteDraft.ts');
  assert.equal(m.resolveHistoryRouteRestore(null).kind, 'off');
  assert.equal(m.resolveHistoryRouteRestore({ runtime_id: 'x', router: null }).kind, 'off');
  assert.equal(
    m.resolveHistoryRouteRestore(routedSummary({ launchTransport: 'direct' })).kind,
    'off',
  );
});

test('resolveRouterLaunchDraft: restored drafts require the runtime resume path', async () => {
  const m = await importModule('src/components/workspace/composerRouteDraft.ts');
  const restored = m.resolveHistoryRouteRestore(routedSummary());
  const resolution = m.resolveRouterLaunchDraft(restored.draft, routerConfig());
  assert.equal(resolution.ok, false);
  assert.equal(resolution.code, 'HISTORY_RUNTIME_REQUIRED');
  assert.equal('value' in resolution, false);
});

test('history continuation fails closed until Claude route resolution is ready', async () => {
  const m = await importModule('src/components/workspace/composerRouteDraft.ts');
  for (const status of ['idle', 'resolving', 'failed']) {
    assert.equal(m.isHistoryRouteContinuationBlocked('claude', status), true);
  }
  assert.equal(m.isHistoryRouteContinuationBlocked('claude', 'ready'), false);
  assert.equal(m.isHistoryRouteContinuationBlocked('codex', 'failed'), false);
  assert.equal(m.isHistoryRouteContinuationBlocked('opencode', 'resolving'), false);
});

test('labels: restored sources label custom/default-only/profile by id+revision', async () => {
  const m = await importModule('src/components/workspace/composerRouteDraft.ts');
  const config = routerConfig();
  const gone = m.resolveHistoryRouteRestore(routedSummary({
    sourceProfileId: 'profile-gone',
    profileRevision: 9,
  }));
  assert.deepEqual(m.resolveRouteDraftLabel(gone.draft, config), { kind: 'custom' });
  const exact = m.resolveHistoryRouteRestore(routedSummary({
    sourceProfileId: 'profile-a',
    profileRevision: 3,
  }));
  assert.deepEqual(m.resolveRouteDraftLabel(exact.draft, config), { kind: 'profile', profileName: '方案A' });
  const stale = m.resolveHistoryRouteRestore(routedSummary({
    sourceProfileId: 'profile-a',
    profileRevision: 2,
  }));
  assert.deepEqual(m.resolveRouteDraftLabel(stale.draft, config), { kind: 'custom' });
  const empty = m.resolveHistoryRouteRestore(routedSummary({
    bindings: {},
    allowedEnvs: ['GLM-5.3'],
    sourceProfileId: null,
    profileRevision: null,
  }));
  assert.deepEqual(m.resolveRouteDraftLabel(empty.draft, config), { kind: 'defaultOnly' });
  const builtInDefaultOnly = m.resolveHistoryRouteRestore(routedSummary({
    bindings: {},
    allowedEnvs: ['GLM-5.3'],
    sourceProfileId: m.DEFAULT_ONLY_PROFILE_ID,
    profileRevision: null,
  }));
  assert.deepEqual(
    m.resolveRouteDraftLabel(builtInDefaultOnly.draft, config),
    { kind: 'defaultOnly' },
  );
  const dynamicOnly = m.resolveHistoryRouteRestore(routedSummary({
    bindings: {},
    allowedEnvs: ['GLM-5.3', 'DeepSeek-V4-Flash'],
    sourceProfileId: null,
    profileRevision: null,
  }));
  assert.deepEqual(
    m.resolveRouteDraftLabel(dynamicOnly.draft, config),
    { kind: 'custom' },
    'an empty binding map is not default-only when another env remains authorized',
  );
});

test('user selection drops the restored reference and re-resolves against current config', async () => {
  const m = await importModule('src/components/workspace/composerRouteDraft.ts');
  const restored = m.resolveHistoryRouteRestore(routedSummary());
  const userPick = m.selectRouteDraftSource(restored.draft, 'profile-a');
  assert.equal(userPick.restoredSource, undefined);
  const resolution = m.resolveRouterLaunchDraft(userPick, routerConfig());
  assert.equal(resolution.ok, true);
  assert.equal(resolution.value.sourceProfileId, 'profile-a');
});

test('store: memory → persisted explicit choice → fresh; A/B/A retention', async () => {
  const m = await importModule('src/components/workspace/historyRouteDraftStore.ts');
  const storage = fakeStorage();
  const store = m.createHistoryRouteDraftStore(storage);
  const keyA = m.historyRouteDraftKey({ source: 'claude', id: 'session-a', project: '/repo' });
  const keyB = m.historyRouteDraftKey({ source: 'claude', id: 'session-b', project: '/repo' });

  assert.equal(store.take(keyA).optIn, false, 'new session defaults off');

  store.save(keyA, { optIn: true, profileId: 'profile-a' });
  assert.equal(store.take(keyB).optIn, false, 'B does not inherit A draft');
  assert.equal(store.take(keyA).profileId, 'profile-a');

  const reopened = m.createHistoryRouteDraftStore(storage);
  assert.deepEqual(reopened.take(keyA), { optIn: true, profileId: 'profile-a' });

  store.clear(keyA);
  assert.equal(store.take(keyA).optIn, false, 'cleared after successful continue');
  const reopened2 = m.createHistoryRouteDraftStore(storage);
  assert.equal(reopened2.take(keyA).optIn, false, 'clear also removes persisted entry');
  assert.equal(
    (storage.snapshot()[m.HISTORY_ROUTE_DRAFT_STORAGE_KEY] ?? '').includes('session-a'),
    false,
  );
});

test('store: restored runtime references never persist', async () => {
  const m = await importModule('src/components/workspace/historyRouteDraftStore.ts');
  const storage = fakeStorage();
  const store = m.createHistoryRouteDraftStore(storage);
  const key = m.historyRouteDraftKey({ source: 'claude', id: 'session-r', project: '/repo' });
  store.save(key, {
    optIn: true,
    profileId: null,
    restoredSource: { runtimeId: 'native-1', sourceProfileId: null, profileRevision: null, isDefaultOnly: false },
  });
  const raw = storage.snapshot()[m.HISTORY_ROUTE_DRAFT_STORAGE_KEY];
  assert.ok(!raw || !raw.includes('session-r'), 'restored reference must stay memory-only');
  const reopened = m.createHistoryRouteDraftStore(storage);
  assert.equal(reopened.take(key).optIn, false);
});

test('store: bounded entries, bad JSON tolerance, key normalization', async () => {
  const m = await importModule('src/components/workspace/historyRouteDraftStore.ts');
  const storageKey = m.HISTORY_ROUTE_DRAFT_STORAGE_KEY;

  const corrupt = fakeStorage({ [storageKey]: '{not json' });
  const corruptStore = m.createHistoryRouteDraftStore(corrupt);
  assert.equal(corruptStore.take('any').optIn, false);
  corruptStore.save('k', { optIn: true, profileId: null });
  assert.equal(corruptStore.take('k').optIn, true, 'write after corruption recovers');

  const bounded = fakeStorage();
  const boundedStore = m.createHistoryRouteDraftStore(bounded);
  const cap = 100;
  for (let i = 0; i < cap + 10; i += 1) {
    boundedStore.save(`k-${i}`, { optIn: true, profileId: null });
  }
  const persisted = JSON.parse(bounded.snapshot()[storageKey]);
  assert.equal(persisted.entries.length, cap, 'entry count bounded');
  assert.ok(
    persisted.entries.every((entry) => !entry.key.startsWith('k-0')),
    'oldest entries evicted first',
  );

  assert.equal(
    m.historyRouteDraftKey({ source: 'Claude', id: 'x', project: '/repo/' }),
    m.historyRouteDraftKey({ source: 'claude', id: 'x', project: '/repo' }),
  );
  assert.notEqual(
    m.historyRouteDraftKey({ source: 'claude', id: 'x', project: '/repo' }),
    m.historyRouteDraftKey({ source: 'claude', id: 'x', project: '/other' }),
  );
});

test('shortcut enable then submit payload carries routerLaunchDraft (frozen chain)', async () => {
  const m = await importModule('src/components/workspace/composerRouteDraft.ts');
  const enabled = m.toggleComposerRouteDraft(true);
  const resolution = m.resolveRouterLaunchDraft(enabled, routerConfig());
  assert.equal(resolution.ok, true);
  assert.equal(resolution.value.sourceProfileId, MY_DEFAULT);
  assert.deepEqual(resolution.value.bindings, { 'subagent:Explore': 'DeepSeek-V4-Flash' });
});
