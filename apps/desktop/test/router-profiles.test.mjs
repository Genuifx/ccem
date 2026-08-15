import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importRouterProfiles() {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'lib', 'routerProfiles.ts'),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-router-profiles-'));
  const outputPath = path.join(tempDir, 'routerProfiles.mjs');
  // The module value-imports MY_DEFAULT_ROUTER_PROFILE_ID from
  // '@ccem/core/browser'; point that specifier at the built core dist so the
  // transpiled copy stays importable from the temp dir.
  const coreBrowserUrl = pathToFileURL(
    path.join(desktopDir, '..', '..', 'packages', 'core', 'dist', 'browser.js'),
  ).href;
  const importable = output.outputText.replaceAll(
    "'@ccem/core/browser'",
    JSON.stringify(coreBrowserUrl),
  );
  await fs.writeFile(outputPath, importable, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

const PROFILES = [
  { id: 'budget', name: '省钱杂活', revision: 3, bindings: { 'subagent:Explore': 'glm', background: 'deepseek' }, allowedEnvs: ['official', 'glm', 'deepseek'] },
];

function makeRouter(over = {}) {
  return {
    launchTransport: 'routed',
    defaultEnv: 'official',
    bindings: {},
    allowedEnvs: ['official'],
    sourceProfileId: null,
    profileRevision: null,
    dynamicRouting: true,
    revision: 1,
    warnings: [],
    ...over,
  };
}

test('resolveRouteLabel: direct transport always reads as direct', async () => {
  const { resolveRouteLabel } = await importRouterProfiles();
  assert.equal(resolveRouteLabel(makeRouter({ launchTransport: 'direct' }), PROFILES).kind, 'direct');
  assert.equal(resolveRouteLabel(null, PROFILES).kind, 'direct');
});

test('resolveRouteLabel: default-only profile id', async () => {
  const { resolveRouteLabel } = await importRouterProfiles();
  const info = resolveRouteLabel(makeRouter({ sourceProfileId: 'default-only' }), PROFILES);
  assert.equal(info.kind, 'defaultOnly');
});

test('resolveRouteLabel: my-default source keeps the my-defaults label, with or without bindings', async () => {
  const { resolveRouteLabel } = await importRouterProfiles();

  const emptyBindings = resolveRouteLabel(makeRouter({ sourceProfileId: 'my-default' }), PROFILES);
  assert.equal(emptyBindings.kind, 'myDefault');

  const withBindings = resolveRouteLabel(
    makeRouter({ sourceProfileId: 'my-default', bindings: { background: 'glm' } }),
    PROFILES,
  );
  assert.equal(withBindings.kind, 'myDefault');
});

test('resolveRouteLabel: clearing the source by manual edit reads as custom, not my-default', async () => {
  const { resolveRouteLabel } = await importRouterProfiles();

  const custom = resolveRouteLabel(
    makeRouter({ sourceProfileId: null, bindings: { background: 'glm' } }),
    PROFILES,
  );
  assert.equal(custom.kind, 'custom');

  const clearedEmpty = resolveRouteLabel(makeRouter({ sourceProfileId: null }), PROFILES);
  assert.equal(clearedEmpty.kind, 'defaultOnly');
});

test('resolveRouteLabel: a state WITH bindings must NOT be mislabeled as defaultEnv', async () => {
  const { resolveRouteLabel } = await importRouterProfiles();
  // No profile, but has bindings → custom (never the bare defaultEnv string).
  const info = resolveRouteLabel(
    makeRouter({ bindings: { 'subagent:Explore': 'glm' } }),
    PROFILES,
  );
  assert.equal(info.kind, 'custom');
});

test('resolveRouteLabel: matched user profile surfaces its name', async () => {
  const { resolveRouteLabel } = await importRouterProfiles();
  const info = resolveRouteLabel(makeRouter({ sourceProfileId: 'budget' }), PROFILES);
  assert.equal(info.kind, 'profile');
  assert.equal(info.profileName, '省钱杂活');
});

test('resolveRouteLabel: null sourceProfileId and no bindings is defaultOnly', async () => {
  const { resolveRouteLabel } = await importRouterProfiles();
  assert.equal(resolveRouteLabel(makeRouter(), PROFILES).kind, 'defaultOnly');
});

test('computeCandidateEnvs: includes disabled-but-existing envs and session refs', async () => {
  const { computeCandidateEnvs } = await importRouterProfiles();
  // existing = [official, glm, deepseek]; session references a disabled 'glm' and a deleted 'ghost'.
  const router = makeRouter({
    defaultEnv: 'official',
    bindings: { 'subagent:Explore': 'glm' },
    allowedEnvs: ['official', 'glm', 'ghost'],
  });
  const candidates = computeCandidateEnvs(['official', 'glm', 'deepseek'], router);
  assert.ok(candidates.includes('glm'), 'disabled referenced env must stay in the dropdown');
  assert.ok(candidates.includes('ghost'), 'dangling ref must remain visible to be fixable');
  assert.ok(candidates.includes('deepseek'), 'unreferenced existing env must be selectable');
  // de-duplicated
  assert.equal(candidates.filter((c) => c === 'glm').length, 1);
});

test('computeAutoIncludedEnvs: default env + binding targets, de-duplicated', async () => {
  const { computeAutoIncludedEnvs } = await importRouterProfiles();
  const auto = computeAutoIncludedEnvs('official', { 'subagent:Explore': 'glm', background: 'official' });
  assert.deepEqual([...auto].sort(), ['glm', 'official']);
});

test('computeFinalAllowedEnvs: preserves explicit dynamic-only auth, drops phantoms, keeps disabled', async () => {
  const { computeFinalAllowedEnvs } = await importRouterProfiles();
  // baseAllowed carries an explicit 'kimi' (dynamic-routing-only authorization).
  // 'ghost' is referenced but deleted → must be dropped (else backend 502).
  const existing = ['official', 'glm', 'deepseek', 'kimi'];
  const final = computeFinalAllowedEnvs(
    ['official', 'kimi', 'ghost'],
    'official',
    { 'subagent:Explore': 'glm' },
    existing,
  );
  assert.ok(final.includes('kimi'), 'explicit dynamic-only authorization must be preserved');
  assert.ok(final.includes('glm'), 'binding target auto-included');
  assert.ok(final.includes('official'), 'default env auto-included');
  assert.ok(!final.includes('ghost'), 'deleted/phantom env must be dropped');
});

test('buildProfileApplyPatch: preserves the session main env; unions profile allowedEnvs', async () => {
  const { buildProfileApplyPatch } = await importRouterProfiles();
  // current main 'official' is in budget.allowedEnvs → preserved, present once.
  const kept = buildProfileApplyPatch(makeRouter({ defaultEnv: 'official' }), PROFILES[0]);
  assert.equal(kept.defaultEnv, 'official', 'main env never moves');
  assert.equal(kept.sourceProfileId, 'budget');
  assert.equal(kept.profileRevision, 3);
  assert.deepEqual(kept.bindings, { 'subagent:Explore': 'glm', background: 'deepseek' });
  assert.ok(kept.allowedEnvs.includes('official'));
  assert.ok(kept.allowedEnvs.includes('glm'));
  assert.ok(kept.allowedEnvs.includes('deepseek'));
  assert.equal('dynamicRouting' in kept, false, 'dynamicRouting must be omitted so it is preserved');
});

test('buildProfileApplyPatch: default-only profile keeps main env as the only allowed', async () => {
  const { buildProfileApplyPatch } = await importRouterProfiles();
  const patch = buildProfileApplyPatch(
    makeRouter({ defaultEnv: 'glm' }),
    { id: 'default-only', name: 'x', revision: 1, bindings: {}, allowedEnvs: [] },
  );
  assert.deepEqual(patch.bindings, {});
  assert.deepEqual(patch.allowedEnvs, ['glm']); // defaultEnv only
  assert.equal(patch.sourceProfileId, 'default-only');
});

test('buildProfileApplyPatch: a profile MUST NOT move main — current defaultEnv preserved even when absent from profile', async () => {
  const { buildProfileApplyPatch } = await importRouterProfiles();
  // Session main is 'official'; budget-chores profile only allows the cheap env.
  // Main must stay 'official' (NOT fall back to the cheap target), and
  // 'official' is unioned into allowedEnvs so backend validation passes.
  const cheapOnly = { id: 'budget', name: '省钱杂活', revision: 1, bindings: { 'subagent:Explore': 'glm', background: 'glm' }, allowedEnvs: ['glm'] };
  const patch = buildProfileApplyPatch(makeRouter({ defaultEnv: 'official' }), cheapOnly);
  assert.equal(patch.defaultEnv, 'official', 'applying a binding snapshot must not reroute main');
  assert.ok(patch.allowedEnvs.includes('official'), 'main env unioned into allowedEnvs');
  assert.ok(patch.allowedEnvs.includes('glm'), 'profile allowed env preserved');
  assert.deepEqual(patch.bindings, { 'subagent:Explore': 'glm', background: 'glm' });
});

test('buildProfileApplyPatch: current defaultEnv outside profile.allowedEnvs is still preserved + unioned', async () => {
  const { buildProfileApplyPatch } = await importRouterProfiles();
  // 'kimi' is the session main and NOT in budget.allowedEnvs — it must still be
  // kept as defaultEnv and added to allowedEnvs (no fallback to profileAllowed[0]).
  const patch = buildProfileApplyPatch(makeRouter({ defaultEnv: 'kimi' }), PROFILES[0]);
  assert.equal(patch.defaultEnv, 'kimi', 'never fall back to a profile env');
  assert.ok(patch.allowedEnvs.includes('kimi'), 'main unioned in');
  assert.ok(patch.allowedEnvs.includes('official'));
});

test('buildCustomEditPatch: clears sourceProfileId/profileRevision (diverged = custom)', async () => {
  const { buildCustomEditPatch } = await importRouterProfiles();
  const patch = buildCustomEditPatch({
    defaultEnv: 'official',
    bindings: { 'subagent:Explore': 'glm' },
    allowedEnvs: ['official', 'glm'],
    dynamicRouting: false,
  });
  assert.equal(patch.sourceProfileId, null);
  assert.equal(patch.profileRevision, null);
  assert.equal(patch.dynamicRouting, false);
  assert.deepEqual(patch.bindings, { 'subagent:Explore': 'glm' });
});

test('shouldApplySessionRouter: rejects older revisions (no stale overwrite)', async () => {
  const { shouldApplySessionRouter } = await importRouterProfiles();
  const cur = makeRouter({ revision: 5 });
  assert.equal(shouldApplySessionRouter(cur, makeRouter({ revision: 4 })), false, 'older incoming must be dropped');
  assert.equal(shouldApplySessionRouter(cur, makeRouter({ revision: 5 })), false, 'identical snapshot short-circuits');
  assert.equal(shouldApplySessionRouter(cur, makeRouter({ revision: 6 })), true, 'newer revision applies');
  assert.equal(shouldApplySessionRouter(null, makeRouter({ revision: 1 })), true, 'first entry applies');
});

test('shouldApplySessionRouter: same revision still applies transport/warnings changes', async () => {
  const { shouldApplySessionRouter } = await importRouterProfiles();
  const cur = makeRouter({ revision: 5, launchTransport: 'routed', warnings: [] });
  assert.equal(
    shouldApplySessionRouter(cur, makeRouter({ revision: 5, launchTransport: 'direct' })),
    true,
    'transport flip on same revision must apply',
  );
  assert.equal(
    shouldApplySessionRouter(cur, makeRouter({ revision: 5, warnings: ['ROUTER_UNAVAILABLE'] })),
    true,
    'new warnings on same revision must apply (degraded surface)',
  );
  assert.equal(
    shouldApplySessionRouter(cur, makeRouter({ revision: 5, defaultEnv: 'glm' })),
    true,
    'defaultEnv change on same revision must apply',
  );
});

const PROFILE = (over = {}) => ({
  id: 'budget', name: '省钱杂活', revision: 3,
  bindings: {}, allowedEnvs: ['official'], ...over,
});

test('profileSetBinding: target is unioned into allowedEnvs so backend validation passes', async () => {
  const { profileSetBinding } = await importRouterProfiles();
  const next = profileSetBinding(PROFILE({ allowedEnvs: ['official'] }), 'subagent:Explore', 'glm');
  assert.equal(next.bindings['subagent:Explore'], 'glm');
  assert.ok(next.allowedEnvs.includes('glm'), 'binding target must be added to allowedEnvs');
  assert.ok(next.allowedEnvs.includes('official'), 'existing allowed preserved');
  assert.ok(next.revision > 3, 'revision bumped');
});

test('profileToggleAllowed: binding targets are forced-on and cannot be removed', async () => {
  const { profileSetBinding, profileToggleAllowed } = await importRouterProfiles();
  const p = profileSetBinding(PROFILE({ allowedEnvs: ['official'] }), 'subagent:Explore', 'glm');
  // 'glm' is a binding target → removal rejected (no-op).
  const unchanged = profileToggleAllowed(p, 'glm', false);
  assert.equal(unchanged, p, 'cannot remove a binding target');
  assert.ok(unchanged.allowedEnvs.includes('glm'));
  // 'official' is not a binding target → removable.
  const removed = profileToggleAllowed(p, 'official', false);
  assert.ok(!removed.allowedEnvs.includes('official'));
  // adding a non-present env works.
  const added = profileToggleAllowed(p, 'deepseek', true);
  assert.ok(added.allowedEnvs.includes('deepseek'));
});

test('profileSetName + bumpRevision: revision bumps only on real change; caps at MAX_SAFE_INTEGER', async () => {
  const { profileSetName, bumpRevision } = await importRouterProfiles();
  const p = PROFILE({ revision: 3 });
  assert.equal(profileSetName(p, '省钱杂活'), p, 'no-op rename returns same object');
  const renamed = profileSetName(p, '新名字');
  assert.equal(renamed.name, '新名字');
  assert.equal(renamed.revision, 4);
  assert.equal(bumpRevision(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER, 'caps, never overflows');
  assert.equal(bumpRevision(3), 4);
});

test('applyConfigUpdater: two queued functional updaters compose on fresh base (no stale overwrite)', async () => {
  const { applyConfigUpdater } = await importRouterProfiles();
  const base = { port: 17820, bindings: {}, profiles: [PROFILE({ id: 'p1' })], dynamicRouting: true, defaultAllowedEnvs: [] };
  // Edit 1 (built from base): add a binding to p1.
  const u1 = (b) => ({
    profiles: b.profiles.map((p) => (p.id === 'p1' ? { ...p, bindings: { 'subagent:Explore': 'glm' } } : p)),
  });
  // Edit 2 (built from base): add a second profile.
  const u2 = (b) => ({ profiles: [...b.profiles, { id: 'p2', name: 'two', revision: 1, bindings: {}, allowedEnvs: [] }] });
  // Serialized: apply u1 to base, then u2 to u1's result (fresh base each step).
  const after1 = applyConfigUpdater(base, u1);
  const after2 = applyConfigUpdater(after1, u2);
  assert.equal(after2.profiles.length, 2, 'second profile added');
  assert.deepEqual(after2.profiles[0].bindings, { 'subagent:Explore': 'glm' }, 'first edit preserved (not overwritten by stale snapshot)');
});

test('applyConfigUpdater: plain patch form still works', async () => {
  const { applyConfigUpdater } = await importRouterProfiles();
  const base = { port: 17820, bindings: {}, profiles: [], dynamicRouting: true, defaultAllowedEnvs: [] };
  const next = applyConfigUpdater(base, { port: 17821 });
  assert.equal(next.port, 17821);
  assert.deepEqual(next.bindings, {});
});

test('transport truth is owned by the session, independent of global default edits', async () => {
  const { isSessionRouted, isSessionCasCapable } = await importRouterProfiles();
  const routed = makeRouter({ launchTransport: 'routed' });
  const direct = makeRouter({ launchTransport: 'direct' });
  // Only persisted launchTransport + listener actualPort determine live route capability.
  assert.equal(isSessionRouted(routed), true, 'routed session keeps its persisted transport');
  assert.equal(isSessionRouted(direct), false, 'direct session is direct');
  assert.equal(isSessionRouted(null), false, 'no session → direct/new');
  // routed + live port → CAS allowed.
  assert.equal(isSessionCasCapable(routed, 17820), true);
  // routed but listener port gone → not CAS-capable (degraded).
  assert.equal(isSessionCasCapable(routed, null), false);
  // direct session is never CAS-capable.
  assert.equal(isSessionCasCapable(direct, 17820), false);
});

test('resolveEnvSwitchAction: routed session never routes to the global environment switch', async () => {
  const { resolveEnvSwitchAction } = await importRouterProfiles();
  const routed = makeRouter({ launchTransport: 'routed' });
  const direct = makeRouter({ launchTransport: 'direct' });
  assert.equal(resolveEnvSwitchAction(routed, 17820), 'cas', 'routed + port → CAS');
  assert.equal(resolveEnvSwitchAction(routed, null), 'blocked', 'routed + no port → blocked, NOT global');
  assert.equal(resolveEnvSwitchAction(routed, undefined), 'blocked');
  assert.equal(resolveEnvSwitchAction(direct, 17820), 'global', 'direct → global');
  assert.equal(resolveEnvSwitchAction(null, 17820), 'global', 'no session → global');
});

test('resolveDisplayEnv: routed session chip follows router defaultEnv, not global currentEnv', async () => {
  const { resolveDisplayEnv } = await importRouterProfiles();
  // CAS changed the session defaultEnv to 'glm' while global currentEnv is still 'official'.
  const routed = makeRouter({ launchTransport: 'routed', defaultEnv: 'glm' });
  assert.equal(resolveDisplayEnv('official', routed), 'glm', 'must display the routed session defaultEnv');
  // direct/new session → global currentEnv.
  assert.equal(resolveDisplayEnv('official', makeRouter({ launchTransport: 'direct' })), 'official');
  assert.equal(resolveDisplayEnv('official', null), 'official');
});

test('refQueryAllowsDelete: delete blocked while loading or when references exist', async () => {
  const { refQueryAllowsDelete } = await importRouterProfiles();
  assert.equal(refQueryAllowsDelete({ status: 'loading', refs: [] }), false, 'loading → disabled');
  assert.equal(refQueryAllowsDelete({ status: 'loaded', refs: [] }), true, 'no refs → allowed');
  assert.equal(
    refQueryAllowsDelete({ status: 'loaded', refs: ['router.bindings.subagent:Explore', 'session:r-1'] }),
    false,
    'refs present → disabled',
  );
  assert.equal(refQueryAllowsDelete({ status: 'error', refs: [] }), true, 'error → allow attempt (backend rejects if referenced)');
});

test('isFreshReferenceResponse: stale env-name responses are rejected', async () => {
  const { isFreshReferenceResponse } = await importRouterProfiles();
  assert.equal(isFreshReferenceResponse('glm', 'glm'), true);
  assert.equal(isFreshReferenceResponse('glm', 'official'), false, 'response for a previous env must not leak in');
  assert.equal(isFreshReferenceResponse('glm', ''), false);
});



test('runConfigCommit: on save failure, reload is awaited + onCommit skipped + error rethrown', async () => {
  const { runConfigCommit } = await importRouterProfiles();
  const base = { port: 17820, bindings: {}, profiles: [], dynamicRouting: true, defaultAllowedEnvs: [] };
  const saved = [];
  const reloaded = [];
  const committed = [];
  // Backend persists then apply fails → save rejects.
  const save = async (next) => { saved.push(next); throw new Error('apply failed'); };
  await assert.rejects(
    runConfigCommit({ base, updater: { port: 17821 }, save, reload: async () => { reloaded.push(true); }, onCommit: (n, s) => { committed.push([n, s]); } }),
    /apply failed/,
  );
  assert.equal(saved.length, 1, 'save attempted once');
  assert.equal(reloaded.length, 1, 'reload invoked on failure (store last-good is not assumed truth)');
  assert.equal(committed.length, 0, 'onCommit NOT called on failure');
});

test('runConfigCommit: on success, onCommit called and next returned', async () => {
  const { runConfigCommit } = await importRouterProfiles();
  const base = { port: 17820, bindings: {}, profiles: [], dynamicRouting: true, defaultAllowedEnvs: [] };
  const committed = [];
  const result = await runConfigCommit({
    base,
    updater: { port: 17821 },
    save: async (next) => ({ state: 'ready', requestedPort: next.port, actualPort: next.port, error: null, oauthRoutingEnabled: false }),
    reload: async () => { throw new Error('should not reload on success'); },
    onCommit: (n, s) => { committed.push([n, s]); },
  });
  assert.equal(result.port, 17821);
  assert.equal(committed.length, 1);
});

test('createCommitQueue: a failed commit does not poison subsequent queued commits', async () => {
  const { createCommitQueue } = await importRouterProfiles();
  const q = createCommitQueue();
  const order = [];
  const t1 = q.enqueue(async () => { order.push('t1'); throw new Error('boom'); });
  const t2 = q.enqueue(async () => { order.push('t2'); return { port: 1, bindings: {}, profiles: [], dynamicRouting: true, defaultAllowedEnvs: [] }; });
  await assert.rejects(t1, /boom/);
  const r2 = await t2;
  assert.deepEqual(order, ['t1', 't2'], 'second task still ran after first failed (serialized, non-poisoning)');
  assert.equal(r2.port, 1);
});

// ---------------------------------------------------------------------------
// §4.5 gaps: save-session-draft-as-default + parameterized profile templates.
// ---------------------------------------------------------------------------

const EXISTING = ['official', 'glm', 'deepseek', '团队 Search / 日本'];

test('buildSaveAsDefaultPatch: writes draft bindings/dynamic/allowedEnvs, preserves port/profiles', async () => {
  const { buildSaveAsDefaultPatch } = await importRouterProfiles();
  const patch = buildSaveAsDefaultPatch({
    defaultEnv: 'official',
    bindings: { 'subagent:Explore': 'glm', background: 'glm' },
    baseAllowed: ['official', 'kimi'],
    dynamicRouting: false,
    existingNames: EXISTING,
  });
  // Only the three default-owned keys are touched.
  assert.deepEqual(Object.keys(patch).sort(), ['bindings', 'defaultAllowedEnvs', 'dynamicRouting']);
  assert.equal(patch.port, undefined, 'must NOT touch port');
  assert.equal(patch.profiles, undefined, 'must NOT touch profiles');
  // Draft bindings copied verbatim.
  assert.deepEqual(patch.bindings, { 'subagent:Explore': 'glm', background: 'glm' });
  assert.equal(patch.dynamicRouting, false);
  // default + binding targets + explicit 'kimi' kept; phantom 'kimi' dropped (not in existing).
  assert.ok(patch.defaultAllowedEnvs.includes('official'), 'default env forced-on');
  assert.ok(patch.defaultAllowedEnvs.includes('glm'), 'binding target forced-on');
  assert.ok(!patch.defaultAllowedEnvs.includes('kimi'), 'phantom (deleted) env dropped');
});

test('buildSaveAsDefaultPatch: empty bindings still yields a legal default env only set', async () => {
  const { buildSaveAsDefaultPatch } = await importRouterProfiles();
  const patch = buildSaveAsDefaultPatch({
    defaultEnv: 'glm',
    bindings: {},
    baseAllowed: [],
    dynamicRouting: true,
    existingNames: EXISTING,
  });
  assert.deepEqual(patch.bindings, {});
  assert.deepEqual(patch.defaultAllowedEnvs, ['glm']);
  assert.equal(patch.dynamicRouting, true);
});

test('buildSaveAsDefaultPatch: composes through applyConfigUpdater without clobbering base', async () => {
  const { buildSaveAsDefaultPatch, applyConfigUpdater } = await importRouterProfiles();
  // A realistic global base with port/profiles that must survive.
  const base = {
    port: 17820,
    bindings: { background: 'deepseek' },
    profiles: [{ id: 'p1', name: 'one', revision: 2, bindings: {}, allowedEnvs: ['official'] }],
    dynamicRouting: true,
    defaultAllowedEnvs: ['official', 'deepseek'],
  };
  const patch = buildSaveAsDefaultPatch({
    defaultEnv: 'official',
    bindings: { 'subagent:Explore': 'glm' },
    baseAllowed: ['official'],
    dynamicRouting: false,
    existingNames: EXISTING,
  });
  const next = applyConfigUpdater(base, patch);
  // Preserved Untouched.
  assert.equal(next.port, 17820);
  assert.equal(next.profiles.length, 1);
  assert.equal(next.profiles[0].id, 'p1');
  // Overwritten by the draft.
  assert.deepEqual(next.bindings, { 'subagent:Explore': 'glm' });
  assert.equal(next.dynamicRouting, false);
  assert.deepEqual(next.defaultAllowedEnvs, ['official', 'glm']);
  // Base not mutated.
  assert.equal(base.dynamicRouting, true);
  assert.deepEqual(base.bindings, { background: 'deepseek' });
});

test('isValidTemplateBindingKey: mirrors the core binding-key grammar', async () => {
  const { isValidTemplateBindingKey } = await importRouterProfiles();
  for (const ok of ['background', 'subagent:*', 'subagent:Explore', 'subagent:general-purpose', 'subagent:superpowers:code-reviewer']) {
    assert.equal(isValidTemplateBindingKey(ok), true, `${ok} should be valid`);
  }
  for (const bad of ['', 'main', 'background ', 'subagent:', 'subagent: Explore', 'subagent:bad key', 'ccem:glm', 'subagent:<x>']) {
    assert.equal(isValidTemplateBindingKey(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});

test('isValidTemplateEnv: non-empty + must exist in the live env list', async () => {
  const { isValidTemplateEnv } = await importRouterProfiles();
  assert.equal(isValidTemplateEnv('glm', EXISTING), true);
  assert.equal(isValidTemplateEnv('团队 Search / 日本', EXISTING), true, 'non-alias names are legal binding targets');
  assert.equal(isValidTemplateEnv('ghost', EXISTING), false, 'deleted env rejected');
  assert.equal(isValidTemplateEnv('', EXISTING), false, 'empty rejected');
  assert.equal(isValidTemplateEnv('  ', EXISTING), false, 'whitespace rejected');
  assert.equal(isValidTemplateEnv(undefined, EXISTING), false);
});

test('buildBudgetChoresProfile: binds Explore + background to the chosen env; grammar-valid', async () => {
  const { buildBudgetChoresProfile } = await importRouterProfiles();
  const p = buildBudgetChoresProfile({ id: 'budget-1', name: '省钱杂活', env: 'glm', existingNames: EXISTING });
  assert.equal(p.id, 'budget-1');
  assert.equal(p.name, '省钱杂活');
  assert.equal(p.revision, 1);
  assert.deepEqual(p.bindings, { 'subagent:Explore': 'glm', background: 'glm' });
  // allowedEnvs contains every binding target (passes normalizeProfile).
  assert.deepEqual(p.allowedEnvs, ['glm']);
});

test('buildBudgetChoresProfile: empty / missing / deleted env → null (no fake success)', async () => {
  const { buildBudgetChoresProfile } = await importRouterProfiles();
  assert.equal(buildBudgetChoresProfile({ id: 'b', name: 'x', env: '', existingNames: EXISTING }), null);
  assert.equal(buildBudgetChoresProfile({ id: 'b', name: 'x', env: 'ghost', existingNames: EXISTING }), null, 'deleted env must not produce a profile');
  assert.equal(buildBudgetChoresProfile({ id: 'b', name: 'x', env: undefined, existingNames: EXISTING }), null);
});

test('buildSpecialtyProfile: binds one legal key to the chosen env; editable one-binding profile', async () => {
  const { buildSpecialtyProfile } = await importRouterProfiles();
  const p = buildSpecialtyProfile({ id: 'sp-1', name: '特长分工', env: 'deepseek', key: 'subagent:Plan', existingNames: EXISTING });
  assert.deepEqual(p.bindings, { 'subagent:Plan': 'deepseek' });
  assert.deepEqual(p.allowedEnvs, ['deepseek']);
  // wildcard + background also legal.
  assert.deepEqual(buildSpecialtyProfile({ id: 'sp', name: 'n', env: 'glm', key: 'subagent:*', existingNames: EXISTING }).bindings, { 'subagent:*': 'glm' });
  assert.deepEqual(buildSpecialtyProfile({ id: 'sp', name: 'n', env: 'glm', key: 'background', existingNames: EXISTING }).bindings, { background: 'glm' });
});

test('buildSpecialtyProfile: invalid env OR invalid key → null', async () => {
  const { buildSpecialtyProfile } = await importRouterProfiles();
  // valid key, bad env
  assert.equal(buildSpecialtyProfile({ id: 's', name: 'n', env: 'ghost', key: 'subagent:Plan', existingNames: EXISTING }), null);
  // valid env, bad key
  assert.equal(buildSpecialtyProfile({ id: 's', name: 'n', env: 'glm', key: 'main', existingNames: EXISTING }), null);
  assert.equal(buildSpecialtyProfile({ id: 's', name: 'n', env: 'glm', key: '', existingNames: EXISTING }), null);
  assert.equal(buildSpecialtyProfile({ id: 's', name: 'n', env: 'glm', key: 'subagent:bad key', existingNames: EXISTING }), null);
});

test('template profiles are normalizeProfile-valid (binding targets ⊆ allowedEnvs)', async () => {
  // Validates against the real core normalizer to prove the generated profiles
  // would survive backend persist/router validation.
  const { normalizeRouterConfig } = await import('@ccem/core/browser');
  const { buildBudgetChoresProfile, buildSpecialtyProfile } = await importRouterProfiles();
  const budget = buildBudgetChoresProfile({ id: 'b', name: '省钱杂活', env: 'glm', existingNames: EXISTING });
  const spec = buildSpecialtyProfile({ id: 's', name: '特长分工', env: 'deepseek', key: 'subagent:Plan', existingNames: EXISTING });
  const normalized = normalizeRouterConfig({ profiles: [budget, spec] });
  assert.equal(normalized.profiles.length, 2);
  assert.equal(normalized.profiles[0].bindings['subagent:Explore'], 'glm');
  assert.equal(normalized.profiles[1].bindings['subagent:Plan'], 'deepseek');
});

test('save-as-default failure path does not fake success: runConfigCommit rejects + reloads', async () => {
  // The L2 "save as default" button wraps commitGlobal(); this proves the
  // underlying contract (reload truth, rethrow, onCommit skipped) holds for a
  // patch shaped like buildSaveAsDefaultPatch output.
  const { runConfigCommit, buildSaveAsDefaultPatch } = await importRouterProfiles();
  const base = { port: 17820, bindings: {}, profiles: [], dynamicRouting: true, defaultAllowedEnvs: ['official'] };
  const patch = buildSaveAsDefaultPatch({ defaultEnv: 'official', bindings: { background: 'glm' }, baseAllowed: ['official'], dynamicRouting: false, existingNames: EXISTING });
  const committed = [];
  const reloaded = [];
  await assert.rejects(
    runConfigCommit({
      base,
      updater: patch,
      save: async () => { throw new Error('persist failed'); },
      reload: async () => { reloaded.push(true); },
      onCommit: () => { committed.push(true); },
    }),
    /persist failed/,
  );
  assert.equal(committed.length, 0, 'must NOT call onCommit on failure (no fake success)');
  assert.equal(reloaded.length, 1, 'must reload the persisted truth before rejecting');
});

// ---------------------------------------------------------------------------
// §concurrency: global singleton CommitQueue (all hook consumers share it) +
// per-runtime keyed CAS serializer. Proves cross-call composition, the
// always-write onCommit unmount contract, and keyed ordering/parallelism.
// ---------------------------------------------------------------------------

function baseConfig(over = {}) {
  return { port: 1, bindings: {}, profiles: [], dynamicRouting: true, defaultAllowedEnvs: [], ...over };
}
function p1() {
  return { id: 'p1', name: 'one', revision: 1, bindings: {}, allowedEnvs: [] };
}

test('global singleton queue: cross-call edits on a SHARED queue compose (no clobber)', async () => {
  const { createCommitQueue, applyConfigUpdater } = await importRouterProfiles();
  const queue = createCommitQueue();
  let store = baseConfig();
  // Mirrors the hook: each task reads the FRESH store base at execution.
  const commitLike = (updater) => queue.enqueue(async () => {
    const next = applyConfigUpdater(store, updater);
    await Promise.resolve();
    store = next;
    return next;
  });
  // Two independent callers enqueue "at once".
  const a = commitLike({ port: 2 });
  const b = commitLike((s) => ({ profiles: [...s.profiles, p1()] }));
  await Promise.all([a, b]);
  assert.equal(store.port, 2, 'port edit preserved');
  assert.equal(store.profiles.length, 1, 'profiles edit preserved — B saw A\'s fresh base');
});

test('singleton + always-write onCommit: an unmounted caller still updates the store; next task composes', async () => {
  const { createCommitQueue, applyConfigUpdater } = await importRouterProfiles();
  const queue = createCommitQueue();
  let store = baseConfig();
  // CORRECTED hook: onCommit ALWAYS writes (Zustand setters are safe post-unmount).
  const commitLike = (updater) => queue.enqueue(async () => {
    const next = applyConfigUpdater(store, updater);
    await Promise.resolve();
    store = next; // always
    return next;
  });
  const a = commitLike({ port: 2 }); // caller "unmounts" — write still lands
  const b = commitLike((s) => ({ profiles: [...s.profiles, p1()] }));
  await Promise.all([a, b]);
  assert.equal(store.port, 2, 'unmounted caller A still wrote its result');
  assert.equal(store.profiles.length, 1, 'B composed on the fresh base — no clobber');
});

test('regression: a mount-gated onCommit drops an unmounted caller write → next task clobbers', async () => {
  const { createCommitQueue, applyConfigUpdater } = await importRouterProfiles();
  const queue = createCommitQueue();
  let store = baseConfig();
  // OLD buggy hook: write only when mounted.
  const commitLikeGated = (updater, mounted) => queue.enqueue(async () => {
    const next = applyConfigUpdater(store, updater);
    await Promise.resolve();
    if (mounted) store = next;
    return next;
  });
  const a = commitLikeGated({ port: 2 }, false); // unmounted → write skipped
  const b = commitLikeGated((s) => ({ profiles: [...s.profiles, p1()] }), true);
  await Promise.all([a, b]);
  assert.equal(store.port, 1, "A's port edit was dropped — the bug the mount gate caused");
});

test('createKeyedCommitQueues: same key runs in submission order (serialized)', async () => {
  const { createKeyedCommitQueues } = await importRouterProfiles();
  const q = createKeyedCommitQueues();
  let aStarted = false, bStartedBeforeAEnd = false, aEnded = false;
  let releaseA;
  const a = q.enqueue('r1', async () => {
    aStarted = true;
    await new Promise((r) => { releaseA = r; });
    aEnded = true;
    return 'A';
  });
  const b = q.enqueue('r1', async () => {
    if (!aEnded) bStartedBeforeAEnd = true;
    return 'B';
  });
  for (let i = 0; i < 1000 && !aStarted; i++) await Promise.resolve();
  assert.equal(aStarted, true, 'A started');
  await new Promise((r) => setTimeout(r, 5)); // give B a chance to (wrongly) start
  assert.equal(bStartedBeforeAEnd, false, 'B must NOT start before A ends (same key = serial)');
  releaseA();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra, 'A');
  assert.equal(rb, 'B');
});

test('createKeyedCommitQueues: different keys run in parallel (independent)', async () => {
  const { createKeyedCommitQueues } = await importRouterProfiles();
  const q = createKeyedCommitQueues();
  let aStarted = false, bStartedWhileAInFlight = false;
  let releaseA;
  const a = q.enqueue('r1', async () => {
    aStarted = true;
    await new Promise((r) => { releaseA = r; });
    return 'A';
  });
  const b = q.enqueue('r2', async () => {
    if (aStarted) bStartedWhileAInFlight = true;
    return 'B';
  });
  for (let i = 0; i < 1000 && !aStarted; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(bStartedWhileAInFlight, true, 'different keys must run concurrently');
  releaseA();
  await Promise.all([a, b]);
});

test('createKeyedCommitQueues: a failed first task does NOT poison the second (same key)', async () => {
  const { createKeyedCommitQueues } = await importRouterProfiles();
  const q = createKeyedCommitQueues();
  let bRan = false;
  const a = q.enqueue('r1', async () => { throw new Error('boom'); });
  const b = q.enqueue('r1', async () => { bRan = true; return 'B'; });
  await assert.rejects(a, /boom/);
  const rb = await b;
  assert.equal(bRan, true, 'second task still ran after the first failed');
  assert.equal(rb, 'B');
});

test('createKeyedCommitQueues: a drained key is released and reusable', async () => {
  const { createKeyedCommitQueues } = await importRouterProfiles();
  const q = createKeyedCommitQueues();
  await q.enqueue('r1', async () => 'first');
  // After the chain drains the key's entry is released; reuse must still serialize.
  const order = [];
  let release;
  const a = q.enqueue('r1', async () => {
    order.push('a');
    await new Promise((r) => { release = r; });
    return 'A';
  });
  const b = q.enqueue('r1', async () => { order.push('b'); return 'B'; });
  for (let i = 0; i < 1000 && order.length === 0; i++) await Promise.resolve();
  assert.deepEqual(order, ['a']);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b'], 'reused key still serializes after a drain');
});

// Fresh-state CAS harness: a per-runtime serializer where each task reads the
// FRESH revision at execution and a mock backend bumps it on success — mirrors
// update_session_router + setSessionRouter. Proves profile/custom/env-switch
// mutations compose (last intent lands) instead of conflicting.
function freshCasHarness({ createKeyedCommitQueues }) {
  const q = createKeyedCommitQueues();
  let store = { revision: 1, defaultEnv: 'official', bindings: {}, allowedEnvs: ['official'], dynamicRouting: true };
  const cas = async (expectedRev, patch) => {
    if (expectedRev !== store.revision) {
      return { ok: false, conflict: { code: 'ROUTER_REVISION_CONFLICT', current: { ...store }, message: 'conflict' } };
    }
    store = { ...store, ...patch, revision: store.revision + 1 };
    return { ok: true, router: { ...store } };
  };
  // mutate(buildPatch): enqueue + read FRESH revision at execution.
  const mutate = (buildPatch) => q.enqueue('r1', async () => cas(store.revision, buildPatch(store)));
  return { mutate, get: () => store };
}

test('fresh-state serializer: profile-apply then custom-apply both land (last intent wins)', async () => {
  const mod = await importRouterProfiles();
  const { mutate, get } = freshCasHarness(mod);
  const a = mutate(() => ({
    bindings: { 'subagent:Explore': 'glm' },
    allowedEnvs: ['official', 'glm'],
    sourceProfileId: 'budget',
    profileRevision: 1,
  }));
  const b = mutate(() => ({
    bindings: { background: 'deepseek' },
    allowedEnvs: ['official', 'deepseek'],
    sourceProfileId: null,
    profileRevision: null,
  }));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true, 'profile CAS succeeded');
  assert.equal(rb.ok, true, 'custom CAS succeeded on the bumped revision — no conflict');
  assert.equal(get().revision, 3, 'revision bumped once per successful mutation');
});

test('fresh-state serializer: profile-apply then env-switch both land', async () => {
  const mod = await importRouterProfiles();
  const { mutate, get } = freshCasHarness(mod);
  const a = mutate(() => ({
    bindings: { 'subagent:Explore': 'glm' },
    allowedEnvs: ['official', 'glm'],
    sourceProfileId: 'budget',
    profileRevision: 1,
  }));
  // env-switch builds from FRESH allowedEnvs at execution.
  const b = mutate((fresh) => ({
    defaultEnv: 'glm',
    allowedEnvs: fresh.allowedEnvs,
    sourceProfileId: null,
    profileRevision: null,
  }));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok && rb.ok, true, 'both mutations landed — env switch used the bumped revision');
  assert.equal(get().defaultEnv, 'glm', 'env switch (last intent) applied');
  assert.equal(get().bindings['subagent:Explore'], 'glm', 'profile bindings preserved');
  assert.equal(get().revision, 3);
});

test('regression: WITHOUT serialization, two same-revision CAS race → second conflicts (last intent lost)', async () => {
  let store = { revision: 1, defaultEnv: 'official', bindings: {}, allowedEnvs: ['official'] };
  const cas = async (expectedRev, patch) => {
    if (expectedRev !== store.revision) return { ok: false, conflict: { code: 'ROUTER_REVISION_CONFLICT', current: { ...store } } };
    store = { ...store, ...patch, revision: store.revision + 1 };
    return { ok: true };
  };
  // Both capture revision=1 at "call time" (no queue, no fresh re-read) → race.
  const revAtCall = store.revision;
  const [ra, rb] = await Promise.all([
    cas(revAtCall, { defaultEnv: 'glm' }),
    cas(revAtCall, { defaultEnv: 'deepseek' }),
  ]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, false, 'second CAS conflicts — the bug the per-runtime serializer fixes');
});

// Transport-truth fail-closed contract for the env hot-switch CAS path.
test('resolveEnvSwitchCasPatch: missing fresh router → failClosed (never a global environment switch)', async () => {
  const { resolveEnvSwitchCasPatch } = await importRouterProfiles();
  assert.equal(resolveEnvSwitchCasPatch(null, 'glm').kind, 'failClosed');
  // Even with a routed session that lost its router mid-queue, we do not produce
  // a CAS patch — the caller must toast + no-op, not switchEnvironment.
  const decision = resolveEnvSwitchCasPatch(null, 'glm');
  assert.equal('patch' in decision, false);
});

test('resolveEnvSwitchCasPatch: unions the new main env into allowedEnvs; preserves the rest', async () => {
  const { resolveEnvSwitchCasPatch } = await importRouterProfiles();
  const fresh = makeRouter({ revision: 7, defaultEnv: 'official', allowedEnvs: ['official', 'kimi'] });
  // envName 'glm' not yet allowed → unioned in.
  const added = resolveEnvSwitchCasPatch(fresh, 'glm');
  assert.equal(added.kind, 'cas');
  assert.equal(added.router.revision, 7, 'uses the FRESH revision');
  assert.deepEqual(added.patch, {
    defaultEnv: 'glm',
    allowedEnvs: ['official', 'kimi', 'glm'],
    sourceProfileId: null,
    profileRevision: null,
  });
  // envName already allowed → allowedEnvs unchanged (no duplicate).
  const present = resolveEnvSwitchCasPatch(fresh, 'kimi');
  assert.deepEqual(present.patch.allowedEnvs, ['official', 'kimi']);
  assert.equal(present.patch.defaultEnv, 'kimi');
});

test('buildMyDefaultApplyPatch: virtual my-default re-seeds from current config without faking a profile', async () => {
  const { buildMyDefaultApplyPatch, MY_DEFAULT_ROUTER_PROFILE_ID } = await importRouterProfiles();

  const config = {
    port: 17820,
    bindings: { 'subagent:Explore': 'glm', background: 'deepseek' },
    profiles: [],
    dynamicRouting: false,
    defaultAllowedEnvs: ['official', 'kimi'],
  };
  // Session main env must be preserved even when absent from config defaults.
  const router = makeRouter({ defaultEnv: 'kimi', dynamicRouting: true, revision: 4 });

  const patch = buildMyDefaultApplyPatch(router, config);
  assert.deepEqual(patch, {
    bindings: { 'subagent:Explore': 'glm', background: 'deepseek' },
    allowedEnvs: ['kimi', 'official', 'glm', 'deepseek'],
    sourceProfileId: MY_DEFAULT_ROUTER_PROFILE_ID,
    profileRevision: null,
    dynamicRouting: false,
  });
  // defaultEnv is intentionally omitted (preserved by the partial patch).
  assert.equal('defaultEnv' in patch, false);
  assert.ok(!('revision' in patch));
});

test('buildMyDefaultApplyPatch: union de-duplicates and drops empty targets', async () => {
  const { buildMyDefaultApplyPatch } = await importRouterProfiles();

  const config = {
    port: 17820,
    bindings: { background: 'official', 'subagent:Plan': '  ' },
    profiles: [],
    dynamicRouting: true,
    defaultAllowedEnvs: ['official', 'official'],
  };
  const router = makeRouter({ defaultEnv: 'official' });

  const patch = buildMyDefaultApplyPatch(router, config);
  assert.deepEqual(patch.allowedEnvs, ['official']);
  assert.deepEqual(patch.bindings, { background: 'official', 'subagent:Plan': '  ' });
});
