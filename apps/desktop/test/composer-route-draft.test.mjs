import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function readSource(...segments) {
  const source = await fs.readFile(path.join(desktopDir, 'src', ...segments), 'utf8');
  return source.replace(/\r\n?/g, '\n');
}

async function importComposerRouteDraft() {
  const compileOptions = {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  };
  const draftSource = await readSource('components', 'workspace', 'composerRouteDraft.ts');
  const profilesSource = await readSource('lib', 'routerProfiles.ts');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-composer-route-draft-'));
  const profilesPath = path.join(tempDir, 'routerProfiles.mjs');
  const draftPath = path.join(tempDir, 'composerRouteDraft.mjs');
  // routerProfiles value-imports MY_DEFAULT_ROUTER_PROFILE_ID from
  // '@ccem/core/browser'; point that specifier at the built core dist so the
  // transpiled copy stays importable from the temp dir.
  const coreBrowserUrl = pathToFileURL(
    path.join(desktopDir, '..', '..', 'packages', 'core', 'dist', 'browser.js'),
  ).href;
  await fs.writeFile(
    profilesPath,
    ts.transpileModule(profilesSource, compileOptions).outputText.replaceAll(
      "'@ccem/core/browser'",
      JSON.stringify(coreBrowserUrl),
    ),
    'utf8',
  );
  // Rewrite the alias import to the sibling transpiled module.
  const draftOutput = ts.transpileModule(draftSource, compileOptions).outputText.replace(
    "'@/lib/routerProfiles'",
    "'./routerProfiles.mjs'",
  );
  await fs.writeFile(draftPath, draftOutput, 'utf8');
  return import(pathToFileURL(draftPath).href);
}

const ROUTER_CONFIG = {
  port: 17820,
  bindings: { 'subagent:Explore': 'glm', background: 'deepseek' },
  profiles: [
    {
      id: 'budget',
      name: '省钱杂活',
      revision: 3,
      bindings: { background: 'kimi' },
      allowedEnvs: ['official', 'kimi'],
    },
  ],
  dynamicRouting: true,
  defaultAllowedEnvs: ['official', 'glm', 'deepseek'],
};

test('new composer drafts start opted out and render no route pill', async () => {
  const { createComposerRouteDraft, isRouteDraftPillVisible } = await importComposerRouteDraft();

  const draft = createComposerRouteDraft();
  assert.equal(draft.optIn, false);
  assert.equal(draft.profileId, null);
  assert.equal(isRouteDraftPillVisible(draft, 'claude'), false, 'opted-out draft must show no pill');
});

test('only real Claude composers are eligible for the routing draft UI', async () => {
  const { createComposerRouteDraft, isRouteDraftPillVisible, isRouteDraftRowVisible } =
    await importComposerRouteDraft();

  const draft = { ...createComposerRouteDraft(), optIn: true };
  assert.equal(isRouteDraftPillVisible(draft, 'codex'), false);
  assert.equal(isRouteDraftRowVisible('codex'), false);
  assert.equal(isRouteDraftPillVisible(draft, 'opencode'), false);
  assert.equal(isRouteDraftRowVisible('opencode'), false);
  assert.equal(isRouteDraftRowVisible('claude'), true);
});

test('enabling the draft shows the pill for claude composers', async () => {
  const { createComposerRouteDraft, isRouteDraftPillVisible } = await importComposerRouteDraft();

  const draft = { ...createComposerRouteDraft(), optIn: true };
  assert.equal(isRouteDraftPillVisible(draft, 'claude'), true);
});

test('resolved launch seed carries the FULL config snapshot when enabled without a profile', async () => {
  const { createComposerRouteDraft, resolveRouterLaunchDraft, MY_DEFAULT_ROUTER_PROFILE_ID } =
    await importComposerRouteDraft();

  assert.equal(MY_DEFAULT_ROUTER_PROFILE_ID, 'my-default');
  const draft = { ...createComposerRouteDraft(), optIn: true };
  const result = resolveRouterLaunchDraft(draft, ROUTER_CONFIG);
  assert.ok(result.ok, 'my-defaults snapshot must resolve');
  assert.deepEqual(result.value, {
    bindings: { 'subagent:Explore': 'glm', background: 'deepseek' },
    allowedEnvs: ['official', 'glm', 'deepseek'],
    sourceProfileId: 'my-default',
    profileRevision: null,
    dynamicRouting: true,
  });
});

test('resolved launch seed expands the selected named profile', async () => {
  const { createComposerRouteDraft, resolveRouterLaunchDraft } = await importComposerRouteDraft();

  const draft = { optIn: true, profileId: 'budget' };
  const result = resolveRouterLaunchDraft(draft, ROUTER_CONFIG);
  assert.ok(result.ok);
  assert.deepEqual(result.value, {
    bindings: { background: 'kimi' },
    allowedEnvs: ['official', 'kimi'],
    sourceProfileId: 'budget',
    profileRevision: 3,
    dynamicRouting: true,
  });
});

test('resolved launch seed supports the built-in main-env-only choice without faking a stored profile', async () => {
  const { resolveRouterLaunchDraft, DEFAULT_ONLY_PROFILE_ID } = await importComposerRouteDraft();

  const result = resolveRouterLaunchDraft(
    { optIn: true, profileId: DEFAULT_ONLY_PROFILE_ID },
    ROUTER_CONFIG,
  );
  assert.ok(result.ok);
  assert.deepEqual(result.value, {
    bindings: {},
    allowedEnvs: [],
    sourceProfileId: null,
    profileRevision: null,
    dynamicRouting: true,
  });
});

test('opted-out drafts omit the launch seed entirely (legacy single-env launch)', async () => {
  const { createComposerRouteDraft, resolveRouterLaunchDraft } = await importComposerRouteDraft();

  const result = resolveRouterLaunchDraft(createComposerRouteDraft(), ROUTER_CONFIG);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_OPTED_IN');
  assert.equal('value' in result, false, 'no partial seed may leak for opted-out drafts');
});

test('a selected profile deleted before submit blocks the send instead of silently falling back', async () => {
  const { resolveRouterLaunchDraft } = await importComposerRouteDraft();

  const result = resolveRouterLaunchDraft({ optIn: true, profileId: 'gone' }, ROUTER_CONFIG);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROFILE_MISSING');
  assert.equal('value' in result, false);
});

test('a missing router config blocks an opted-in send instead of guessing defaults', async () => {
  const { resolveRouterLaunchDraft } = await importComposerRouteDraft();

  const result = resolveRouterLaunchDraft({ optIn: true, profileId: null }, null);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CONFIG_UNAVAILABLE');
});

test('drafts reset to the same off state a brand-new composer starts with', async () => {
  const { createComposerRouteDraft, resetComposerRouteDraft } = await importComposerRouteDraft();

  const draft = { optIn: true, profileId: 'budget' };
  assert.deepEqual(resetComposerRouteDraft(draft), createComposerRouteDraft());
  assert.deepEqual(resetComposerRouteDraft(createComposerRouteDraft()), createComposerRouteDraft());
});

test('toggling the draft off clears the profile selection; re-enabling starts from my defaults', async () => {
  const { toggleComposerRouteDraft, createComposerRouteDraft } = await importComposerRouteDraft();

  const enabled = toggleComposerRouteDraft(true);
  assert.deepEqual(enabled, { optIn: true, profileId: null });

  const withProfile = { ...enabled, profileId: 'budget' };
  const disabled = toggleComposerRouteDraft(false);
  assert.deepEqual(disabled, createComposerRouteDraft(), 'off must fully reset the draft');
  assert.deepEqual(withProfile.optIn, true);
});

test('draft pill label distinguishes my-defaults from a named profile', async () => {
  const { resolveRouteDraftLabel, DEFAULT_ONLY_PROFILE_ID } = await importComposerRouteDraft();

  assert.equal(resolveRouteDraftLabel({ optIn: true, profileId: null }, ROUTER_CONFIG).kind, 'myDefault');
  assert.equal(
    resolveRouteDraftLabel({ optIn: true, profileId: DEFAULT_ONLY_PROFILE_ID }, ROUTER_CONFIG).kind,
    'defaultOnly',
  );
  const profile = resolveRouteDraftLabel({ optIn: true, profileId: 'budget' }, ROUTER_CONFIG);
  assert.equal(profile.kind, 'profile');
  assert.equal(profile.profileName, '省钱杂活');
});

test('draft label never claims a profile that no longer exists', async () => {
  const { resolveRouteDraftLabel } = await importComposerRouteDraft();

  const label = resolveRouteDraftLabel({ optIn: true, profileId: 'gone' }, ROUTER_CONFIG);
  assert.equal(label.kind, 'missingProfile');
});

test('source regression: every fresh-Composer entry point resets the routing draft', async () => {
  const source = await readSource('pages', 'Workspace.tsx');

  // 1. Successful compose launch resets the draft (next Composer starts off).
  const composeBlock = source.slice(
    source.indexOf('const runCreateNativeConversation = useCallback'),
    source.indexOf('  }, [', source.indexOf('const runCreateNativeConversation = useCallback')),
  );
  assert.ok(
    composeBlock.includes('updateComposeRouteDraftState(createComposerRouteDraft())'),
    'compose launch success must reset the draft',
  );

  // 2. Successful history-continue launch resets its draft too.
  const historyBlock = source.slice(
    source.indexOf('const runContinueHistorySession = useCallback'),
    source.indexOf('  }, [', source.indexOf('const runContinueHistorySession = useCallback')),
  );
  assert.ok(
    historyBlock.includes('updateHistoryRouteDraftState(createComposerRouteDraft())'),
    'history continue success must reset the draft',
  );

  // 3. openComposer (explicit Start New entry) resets the compose draft.
  const openComposerBlock = source.slice(
    source.indexOf('const openComposer = useCallback'),
    source.indexOf('  }, [', source.indexOf('const openComposer = useCallback')),
  );
  assert.ok(
    openComposerBlock.includes('updateComposeRouteDraftState(createComposerRouteDraft())'),
    'openComposer must reset the draft',
  );

  // 4. The composeSeed (/ccem-cron) effect resets the compose draft.
  const seedEffectStart = source.indexOf('lastComposeSeedIdRef.current = composeSeed.id;');
  const seedEffectBlock = source.slice(
    seedEffectStart,
    source.indexOf('  }, [', seedEffectStart),
  );
  assert.ok(
    seedEffectBlock.includes('updateComposeRouteDraftState(createComposerRouteDraft())'),
    'composeSeed effect must reset the draft',
  );

  // 5. WorkspaceNativeSessionView onStartNew resets the compose draft.
  const startNewIndex = source.indexOf('onStartNew={() => {');
  const startNewBlock = source.slice(startNewIndex, source.indexOf('})}', startNewIndex));
  assert.ok(
    startNewBlock.includes('updateComposeRouteDraftState(createComposerRouteDraft())'),
    'onStartNew must reset the draft',
  );

  // 6. History sessions hydrate their own provider+id+cwd draft instead of
  // resetting every selection to off.
  assert.ok(
    source.includes('const draftKey = historyRouteDraftKey(session);')
      && source.includes('readHistoryRouteDraft(window.localStorage, draftKey)'),
    'history selection must hydrate the keyed persisted draft',
  );
  assert.ok(
    source.includes('conversationRequestSeqRef.current += 1'),
    'a new history selection must invalidate the previous transcript request immediately',
  );
  const handleSelectBlock = source.slice(
    source.indexOf('const handleSelect = useCallback'),
    source.indexOf('const selectNativeSessionSummary = useCallback'),
  );
  assert.match(
    handleSelectBlock,
    /setMessages\(\[\]\);[\s\S]*setSegments\(\[\]\);[\s\S]*setHistoryEvents\(\[\]\);[\s\S]*setIsLoadingMessages\(true\);/,
    'B selection must synchronously remove A transcript while B resolves',
  );
  assert.ok(
    handleSelectBlock.includes('setIsLoadingMessages(false);'),
    'a selection resolved to a live session must close the history loading state',
  );
  assert.ok(
    handleSelectBlock.includes("updateHistoryRouteResolutionStatus(requiresRouteResolution ? 'resolving' : 'ready')")
      && handleSelectBlock.includes("updateHistoryRouteResolutionStatus('failed')"),
    'Claude history route lookup must remain blocked while pending and fail closed on lookup errors',
  );
});

test('source regression: opted-in submit carries the draft; opted-out omits it; failures keep it', async () => {
  const source = await readSource('pages', 'Workspace.tsx');
  const composeBlock = source.slice(
    source.indexOf('const runCreateNativeConversation = useCallback'),
    source.indexOf('  }, [', source.indexOf('const runCreateNativeConversation = useCallback')),
  );
  assert.ok(composeBlock.includes('resolveRouterLaunchDraft('), 'submit must resolve the seed');
  assert.ok(composeBlock.includes('routerLaunchDraft,'), 'create call must carry the draft');
  assert.ok(
    composeBlock.includes('if (routerLaunchDraft) {'),
    'opted-in failures must surface the backend error specifically',
  );

  const codexGuard = source.indexOf("if (composeProvider !== 'claude') {\n      updateComposeRouteDraftState(createComposerRouteDraft());");
  assert.notEqual(codexGuard, -1, 'switching to a non-routing provider must clear the draft');
});

test('source regression: history routing uses the real history source, never the OpenCode-as-Claude display fallback', async () => {
  const source = await readSource('pages', 'Workspace.tsx');
  const historyView = source.slice(
    source.indexOf('const renderHistoryView = () => {'),
    source.indexOf('\n  if (isLoadingEnvs', source.indexOf('const renderHistoryView = () => {')),
  );

  assert.match(
    historyView,
    /const historyRouteDraftAvailable = selectedHistorySupportsInline\s*&& isRouteDraftRowVisible\(selectedSession\.source\);/,
    'history route capability must be derived from selectedSession.source, not historyProvider',
  );
  assert.match(
    historyView,
    /routeDraft=\{historyRouteDraftAvailable \? historyRouteDraft : null\}/,
    'unsupported history providers must receive no route draft',
  );
  assert.match(
    historyView,
    /onRouteDraftChange=\{historyRouteDraftAvailable \? updateHistoryRouteDraft : undefined\}/,
    'unsupported history providers must receive no route draft callback',
  );
  assert.ok(
    historyView.includes('disabled={!selectedHistorySupportsInline || historyRouteResolutionBlocked}')
      && historyView.includes('&& !historyRouteResolutionBlocked'),
    'history Composer must remain disabled until Claude route resolution succeeds',
  );

  const continueBlock = source.slice(
    source.indexOf('const runContinueHistorySession = useCallback'),
    source.indexOf('  }, [', source.indexOf('const runContinueHistorySession = useCallback')),
  );
  assert.ok(
    continueBlock.includes('isHistoryRouteContinuationBlocked('),
    'submit handler must independently enforce the route-resolution gate',
  );
});

test('wire contract: create_native_session request type carries the Core-owned routerLaunchDraft', async () => {
  const source = await readSource('lib', 'tauri-ipc.ts');

  const commandStart = source.indexOf('create_native_session: [');
  const commandBlock = source.slice(commandStart, source.indexOf('];', commandStart));
  assert.match(
    commandBlock,
    /routerLaunchDraft\?: RouterLaunchDraft \| null;/,
    'InvokeCommandMap request shape must include routerLaunchDraft',
  );

  // The type must be the Core export, not a local duplicate.
  assert.match(
    source,
    /import type \{\n(?:[^}]*\n)*\s*RouterLaunchDraft,(?:[^}]*\n)*\} from '@ccem\/core\/browser';/,
    'RouterLaunchDraft must be imported from @ccem/core/browser',
  );
  assert.ok(
    !/interface RouterLaunchDraft|type RouterLaunchDraft =/.test(source),
    'tauri-ipc must not locally redefine the wire type',
  );

  // The hook actually sends it.
  const hookSource = await readSource('hooks', 'useTauriCommands.ts');
  assert.match(
    hookSource,
    /routerLaunchDraft: options\.routerLaunchDraft \?\? null,/,
    'createNativeSession must forward the draft (null when omitted)',
  );
});

test('visual acceptance: both pills visibly spell out 动态路由/Dynamic routing plus the current state', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceRouter.tsx');

  // Running routed-session pill: mode prefix + label, degraded variant included.
  const runningPillStart = source.indexOf('export function WorkspaceRoutePill');
  const runningPillBlock = source.slice(runningPillStart, source.indexOf('export ', runningPillStart + 10));
  assert.match(
    runningPillBlock,
    /const label = `\$\{t\('router\.routeDraftTitle'\)\} · \$\{degraded \? t\('router\.degraded'\) : labelText\}`;/,
    'running pill must compose 动态路由 · <label> and a degraded variant',
  );

  // Draft pill: mode prefix + selection label.
  const draftPillStart = source.indexOf('export function ComposerRouteDraftPill');
  const draftPillBlock = source.slice(draftPillStart, source.indexOf('export ', draftPillStart + 10));
  assert.match(
    draftPillBlock,
    /const label = `\$\{t\('router\.routeDraftTitle'\)\} · \$\{selectionLabel\}`;/,
    'draft pill must compose 动态路由 · <selection>',
  );

  // The i18n mode word itself exists in both locales.
  for (const loc of ['zh', 'en']) {
    const locale = JSON.parse(await readSource('locales', `${loc}.json`));
    assert.ok(locale.router.routeDraftTitle, `${loc} router.routeDraftTitle must exist`);
    assert.ok(locale.router.degraded, `${loc} router.degraded must exist`);
  }
});

test('source regression: the single running-session selector offers my-default via the shared CAS queue', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceRouter.tsx');

  // Dedicated hook routes through the SAME per-runtime mutation queue and
  // reads FRESH router + config at execution time.
  const hookStart = source.indexOf('export function useApplyMyDefaultRoute');
  assert.notEqual(hookStart, -1, 'useApplyMyDefaultRoute hook must exist');
  const hookBlock = source.slice(hookStart, source.indexOf('export ', hookStart + 10));
  assert.ok(hookBlock.includes('enqueueSessionRouterMutation(runtimeId'), 'must use the per-runtime queue');
  assert.ok(hookBlock.includes('buildMyDefaultApplyPatch(router, config)'), 'must build the dedicated patch');
  assert.ok(hookBlock.includes('useAppStore.getState().sessionRouters[runtimeId]'), 'must read fresh router');
  assert.ok(hookBlock.includes('useAppStore.getState().routerConfig'), 'must read fresh config');

  const routeBodyStart = source.indexOf('function RoutePopoverBody');
  const routeBody = source.slice(routeBodyStart, source.indexOf('function RouteControl', routeBodyStart));
  assert.notEqual(routeBodyStart, -1, 'RoutePopoverBody must exist');
  assert.ok(routeBody.includes('id: MY_DEFAULT_ROUTER_PROFILE_ID'), 'must render the my-default option');
  assert.ok(routeBody.includes('applyMyDefault'), 'must dispatch through the dedicated hook');
  assert.ok(!source.includes('function ComposerRouteMenuRow'), 'the + menu must not duplicate the running picker');

  // The patch must NOT be produced by faking a RouterProfile.
  const libSource = await readSource('lib', 'routerProfiles.ts');
  const patchStart = libSource.indexOf('export function buildMyDefaultApplyPatch');
  const patchBlock = libSource.slice(patchStart, libSource.indexOf('\n}', patchStart));
  assert.ok(patchBlock.includes('sourceProfileId: MY_DEFAULT_ROUTER_PROFILE_ID'));
  assert.ok(patchBlock.includes('profileRevision: null'));
  assert.ok(patchBlock.includes('dynamicRouting: config.dynamicRouting'));
  assert.ok(!patchBlock.includes('RouterProfile'), 'must not fake a RouterProfile');
});

test('visual layout contract: route popover owns its width and environment rules stay bounded', async () => {
  const routerSource = await readSource('components', 'workspace', 'WorkspaceRouter.tsx');
  const routeBody = routerSource.slice(
    routerSource.indexOf('function RoutePopoverBody'),
    routerSource.indexOf('function RouteControl'),
  );
  const routeControl = routerSource.slice(
    routerSource.indexOf('function RouteControl'),
    routerSource.indexOf('export function WorkspaceRouteChip'),
  );
  assert.match(routeBody, /className="flex min-h-0 w-full flex-col p-0"/);
  assert.match(routeBody, /min-h-0.*overflow-y-auto/s);
  assert.match(routeControl, /w-\[332px\].*max-w-\[calc\(100vw-24px\)\]/s);
  assert.match(routeControl, /max-h-\[var\(--radix-popover-content-available-height\)\].*overflow-hidden/s);
  assert.match(routerSource, /w-\[260px\].*max-h-\[var\(--radix-popover-content-available-height\)\].*overflow-hidden/s);

  const environmentsSource = await readSource('components', 'EnvironmentsRouterRules.tsx');
  // Panel content fills the section width like sibling Environments sections
  // (permission modes, env list) — no artificial max-width flanks.
  assert.match(environmentsSource, /className="w-full"/);
  assert.match(environmentsSource, /grid items-start gap-x-6 gap-y-5 xl:grid-cols-\[minmax\(0,2fr\)_minmax\(320px,1fr\)\]/);
  // Settings-table binding rows: fixed-width control column keeps selects aligned.
  assert.match(environmentsSource, /w-\[170px\] shrink-0 rounded-lg/);
  assert.match(environmentsSource, /divide-y divide-border-subtle\/50/);
  assert.match(environmentsSource, /grid grid-cols-1 2xl:grid-cols-2/);
});

test('interaction contract: running-session route card is a compact immediate profile picker', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceRouter.tsx');
  const routeBody = source.slice(
    source.indexOf('function RoutePopoverBody'),
    source.indexOf('function RouteControl'),
  );

  assert.match(routeBody, /router\.routePickerHint/);
  assert.match(routeBody, /router\.manageProfiles/);
  assert.match(routeBody, /await applyMyDefault\(\)/);
  assert.match(routeBody, /await applyProfile\(profile\)/);
  assert.match(routeBody, /option\.id === selectedProfileId/);
  assert.match(routeBody, /preventDefault\(\).*handleApplyProfile\(option\.id\)/s);
  assert.match(routeBody, /if \(applied\) onClose\(\)/);
  assert.match(routeBody, /onNavigateEnvironments\(\)/);

  for (const removedControl of [
    'setDefaultEnv',
    'setBindings',
    'setBaseAllowed',
    'setDynamic',
    'handleSaveAsDefault',
    "t('router.saveAsDefault')",
    "t('router.apply')",
  ]) {
    assert.ok(
      !routeBody.includes(removedControl),
      `Composer route card must not expose advanced control: ${removedControl}`,
    );
  }
});

test('interaction contract: environment route defaults use progressive disclosure', async () => {
  const source = await readSource('components', 'EnvironmentsRouterRules.tsx');

  assert.match(source, /showDefaultAdvanced/);
  assert.match(source, /showDefaultAgentBindings/);
  assert.match(source, /showProfileAdvanced/);
  assert.match(source, /showProfileAgentBindings/);
  assert.match(source, /environments\.routerAdvanced/);
  assert.match(source, /environments\.routerMoreAgents/);
  assert.match(source, /\{ key: 'background', label: t\('router\.background'\) \}/);
  assert.match(source, /\{ key: 'subagent:Explore', label: 'Explore' \}/);
  assert.match(source, /key: 'subagent:\*'.*router\.subagentAny/s);

  assert.match(source, /useState\(false\).*showDefaultAdvanced|showDefaultAdvanced.*useState\(false\)/s);
  // Shared Disclosure toggle renders the a11y attributes; each disclosure is
  // wired to its state var via the `open` prop.
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /open=\{showDefaultAdvanced\}/);
  assert.match(source, /open=\{showDefaultAgentBindings\}/);
  assert.match(source, /open=\{showProfileAdvanced\}/);
  assert.match(source, /open=\{showProfileAgentBindings\}/);

  const defaultAdvancedStart = source.indexOf('{showDefaultAdvanced ? (');
  assert.notEqual(defaultAdvancedStart, -1, 'default advanced settings must be collapsed');
  const profilesStart = source.indexOf('{/* Profiles CRUD */}', defaultAdvancedStart);
  const defaultAdvancedBlock = source.slice(defaultAdvancedStart, profilesStart);
  assert.match(defaultAdvancedBlock, /routerDefaultAllowedHint/);
  assert.match(defaultAdvancedBlock, /routerDynamicRouting/);

  const profileAdvancedStart = source.indexOf('{showProfileAdvanced ? (');
  assert.notEqual(profileAdvancedStart, -1, 'profile authorization must be collapsed');
  const profileAdvancedBlock = source.slice(profileAdvancedStart, source.indexOf('{/* §4.5', profileAdvancedStart));
  assert.match(profileAdvancedBlock, /router\.allowedEnvs/);
});
