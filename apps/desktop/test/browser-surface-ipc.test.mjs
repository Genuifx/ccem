import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function importBrowserSurfaceIpc() {
  const sourcePath = path.join(desktopDir, 'src', 'lib', 'browserSurfaceIpc.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-browser-surface-ipc-'));
  const outputPath = path.join(tempDir, 'browserSurfaceIpc.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('overlay occlusion round-trips native focus intent without ordinary-show focus stealing', async () => {
  const [commands, windowsMutation, macosMutation, focusRestore, browserPanel] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser', 'login', 'surface_commands.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser', 'login', 'cef', 'surface', 'windows', 'mutation.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser', 'login', 'cef', 'surface', 'macos', 'mutation.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser', 'login', 'cef', 'surface', 'focus_restore.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'), 'utf8'),
  ]);

  const control = commands.slice(
    commands.indexOf('fn transition_control('),
    commands.indexOf('fn close_popup('),
  );
  const occlude = control.slice(control.indexOf('BrowserSurfaceControlActionArg::Occlude =>'));
  assert.ok(occlude.indexOf('pause_agent_if_active') < occlude.indexOf('occlude_surface'));
  assert.match(windowsMutation, /GetFocus\(\)/);
  assert.match(windowsMutation, /IsChild\(root, focused\)/);
  assert.match(macosMutation, /firstResponder\(\)/);
  assert.match(macosMutation, /isDescendantOf\(child\)/);
  assert.match(focusRestore, /current_popup == Some\(popup_id\)/);
  assert.match(focusRestore, /struct FocusRestoreAttempt[\s\S]*revision: u64/);
  assert.match(focusRestore, /peek_for_current_popup\(current_popup\)/);
  assert.match(
    focusRestore,
    /if !restore\(attempt\.target\)\?[\s\S]*commit_if_unchanged\(attempt\)/,
  );
  assert.match(
    focusRestore,
    /self\.target == Some\(restored\.target\) && self\.revision == restored\.revision/,
  );
  assert.doesNotMatch(focusRestore, /self\.target\.take\(\)/);
  assert.match(
    browserPanel,
    /const visible = requestedVisible[\s\S]*&& !surfaceOccludedRef\.current[\s\S]*&& !nativeSurfaceOcclusionStore\.isOccluded\(\)/,
  );
  assert.match(browserPanel, /recovery_states\?\.includes\('renderer_process_terminated'\)/);
  assert.match(browserPanel, /setError\(t\('workspace\.browserRecoveryRendererStopped'\)\)/);
});

test('surface client preserves lease generation and monotonic revision payloads', async () => {
  const {
    browserSurfaceEventMatchesLease,
    browserSurfaceHostShortcutMatchesLease,
    createBrowserSurfaceClient,
    createBrowserSurfaceMutationLane,
    createBrowserSurfaceOrdering,
    highestSequencedSurfaceEventForLease,
  } = await importBrowserSurfaceIpc();
  const calls = [];
  const lease = {
    lease_id: 'lease-a',
    generation: 8,
    client_revision: 1,
    server_sequence: 10,
    backend: 'login',
  };
  const client = createBrowserSurfaceClient({
    invoke: async (command, args) => {
      calls.push([command, args]);
      return command === 'browser_surface_acquire' ? lease : undefined;
    },
  });
  const viewport = { x: 10, y: 20, width: 700, height: 800 };

  assert.equal(await client.acquire({
    panelSessionId: 'session-a',
    backend: 'login',
    workingDir: '/tmp/project',
    profileMode: 'saved',
    profileId: 'profile-a',
    initialUrl: 'https://example.com',
    viewport,
    clientRevision: 1,
  }), lease);
  await client.sync({
    leaseId: 'lease-a',
    generation: 8,
    clientRevision: 2,
    presentationRevision: 17,
    viewport,
    visible: true,
  });
  await client.navigate({
    leaseId: 'lease-a',
    generation: 8,
    clientRevision: 3,
    url: 'https://example.com/next',
  });
  await client.navigationAction({
    leaseId: 'lease-a',
    generation: 8,
    clientRevision: 4,
    action: 'back',
  });
  await client.control({
    leaseId: 'lease-a',
    generation: 8,
    clientRevision: 5,
    action: 'handoff',
    agentSessionId: 'runtime-a',
  });
  await client.closePopup({
    leaseId: 'lease-a',
    generation: 8,
    clientRevision: 6,
  });
  await client.release({
    leaseId: 'lease-a',
    generation: 8,
    clientRevision: 7,
    disposition: 'close',
  });

  assert.deepEqual(calls, [
    ['browser_surface_acquire', {
      panelSessionId: 'session-a',
      backend: 'login',
      workingDir: '/tmp/project',
      profileMode: 'saved',
      profileId: 'profile-a',
      initialUrl: 'https://example.com',
      viewport,
      clientRevision: 1,
    }],
    ['browser_surface_sync', {
      leaseId: 'lease-a',
      generation: 8,
      clientRevision: 2,
      presentationRevision: 17,
      viewport,
      visible: true,
    }],
    ['browser_surface_navigate', {
      leaseId: 'lease-a',
      generation: 8,
      clientRevision: 3,
      url: 'https://example.com/next',
    }],
    ['browser_surface_navigation_action', {
      leaseId: 'lease-a',
      generation: 8,
      clientRevision: 4,
      action: 'back',
    }],
    ['browser_surface_control', {
      leaseId: 'lease-a',
      generation: 8,
      clientRevision: 5,
      action: 'handoff',
      agentSessionId: 'runtime-a',
    }],
    ['browser_surface_close_popup', {
      leaseId: 'lease-a',
      generation: 8,
      clientRevision: 6,
    }],
    ['browser_surface_release', {
      leaseId: 'lease-a',
      generation: 8,
      clientRevision: 7,
      disposition: 'close',
    }],
  ]);

  assert.equal(browserSurfaceEventMatchesLease(
    { leaseId: 'lease-a', generation: 8 },
    { ...lease, cause: 'ready', snapshot: null },
  ), true);
  assert.equal(browserSurfaceEventMatchesLease(
    { leaseId: 'lease-b', generation: 8 },
    { ...lease, cause: 'ready', snapshot: null },
  ), false);
  assert.equal(browserSurfaceEventMatchesLease(
    { leaseId: 'lease-a', generation: 9 },
    { ...lease, cause: 'ready', snapshot: null },
  ), false);
  assert.equal(browserSurfaceHostShortcutMatchesLease(
    { leaseId: 'lease-a', generation: 8 },
    { surface_id: 'login-8-lease-a', action: 'open_search' },
  ), true);
  assert.equal(browserSurfaceHostShortcutMatchesLease(
    { leaseId: 'lease-a', generation: 9 },
    { surface_id: 'login-8-lease-a', action: 'open_search' },
  ), false);
  assert.equal(browserSurfaceHostShortcutMatchesLease(
    { leaseId: 'lease-b', generation: 8 },
    { surface_id: 'login-8-lease-a', action: 'open_search' },
  ), false);
  assert.equal(browserSurfaceHostShortcutMatchesLease(
    { leaseId: 'lease-b', generation: 9, surfaceId: 'login-8-lease-a' },
    { surface_id: 'login-8-lease-a', action: 'open_search' },
  ), true);
  assert.equal(browserSurfaceHostShortcutMatchesLease(
    { leaseId: 'lease-b', generation: 9, surfaceId: 'login-8-lease-a' },
    { surface_id: 'login-9-lease-b', action: 'open_search' },
  ), false);

  const pending = [
    { ...lease, server_sequence: Number.NaN, cause: 'invalid' },
    { ...lease, server_sequence: 14, cause: 'newer', snapshot: { title: 'newer' } },
    { ...lease, server_sequence: 11, cause: 'older', snapshot: { title: 'older' } },
    { ...lease, lease_id: 'lease-b', server_sequence: 99, cause: 'other' },
  ];
  assert.equal(
    highestSequencedSurfaceEventForLease(
      { leaseId: 'lease-a', generation: 8 },
      pending,
    ),
    pending[1],
  );

  const lane = createBrowserSurfaceMutationLane();
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const execution = [];
  const first = lane.enqueue(async (clientRevision) => {
    execution.push(`first:${clientRevision}`);
    await firstMayFinish;
  });
  const second = lane.enqueue(async (clientRevision) => {
    execution.push(`second:${clientRevision}`);
  });
  await Promise.resolve();
  assert.deepEqual(execution, ['first:1'], 'later mutations must not overtake the lane head');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(execution, ['first:1', 'second:2']);

  await assert.rejects(lane.enqueue(async () => {
    throw new Error('fixture failure');
  }), /fixture failure/);
  await lane.enqueue(async (clientRevision) => {
    execution.push(`after-failure:${clientRevision}`);
  });
  assert.equal(execution.at(-1), 'after-failure:4');
  assert.equal(lane.currentRevision(), 4);

  const ordering = createBrowserSurfaceOrdering();
  const appliedSnapshots = [];
  assert.equal(ordering.applySequencedSnapshot(3, { title: 'new' }, (snapshot) => {
    appliedSnapshots.push(snapshot);
  }), true);
  assert.equal(ordering.applySequencedSnapshot(2, { title: 'old' }, (snapshot) => {
    appliedSnapshots.push(snapshot);
  }), false);
  assert.deepEqual(appliedSnapshots, [{ title: 'new' }]);
  ordering.resetServerSequence();
  assert.equal(ordering.applySequencedSnapshot(1, null, () => {}), true);
});

test('central Tauri IPC types include the Mode 2 navigation action contract', async () => {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'lib', 'tauri-ipc.ts'),
    'utf8',
  );
  assert.match(source, /BrowserSurfaceNavigationActionRequest/);
  assert.match(
    source,
    /browser_surface_navigation_action:\s*\[\s*BrowserSurfaceNavigationActionRequest,\s*BrowserSurfaceSnapshotMutationResponse,?\s*\]/,
  );
});

test('a delayed mutation response cannot cross a lease replacement after sequence reset', async () => {
  const {
    applyBrowserSurfaceMutationResponseForLease,
    createBrowserSurfaceOrdering,
  } = await importBrowserSurfaceIpc();
  const ordering = createBrowserSurfaceOrdering();
  const oldLease = { leaseId: 'lease-a', generation: 8 };
  const replacementLease = { leaseId: 'lease-b', generation: 9 };
  let currentLease = oldLease;
  const response = deferred();
  const applied = [];

  const delayedApply = response.promise.then((resolved) => (
    applyBrowserSurfaceMutationResponseForLease(
      ordering,
      currentLease,
      oldLease,
      resolved,
      (snapshot) => applied.push(snapshot),
    )
  ));

  // Reacquire resets the per-panel sequence fence while A is still in flight.
  // Identity must remain the stronger fence even when A returns a large number.
  currentLease = replacementLease;
  ordering.resetServerSequence();
  response.resolve({
    lease_id: oldLease.leaseId,
    generation: oldLease.generation,
    server_sequence: 99,
    snapshot: { title: 'stale lease A' },
  });
  assert.equal(await delayedApply, false);
  assert.deepEqual(applied, []);

  assert.equal(applyBrowserSurfaceMutationResponseForLease(
    ordering,
    currentLease,
    replacementLease,
    {
      lease_id: replacementLease.leaseId,
      generation: replacementLease.generation,
      server_sequence: 1,
      snapshot: { title: 'current lease B' },
    },
    (snapshot) => applied.push(snapshot),
  ), true);
  assert.deepEqual(applied, [{ title: 'current lease B' }]);
});

test('recovery projection exposes only stable states and renders them in the related panel', async () => {
  const [ipcSource, panelSource, chromeSource, enRaw, zhRaw] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src', 'lib', 'browserSurfaceIpc.ts'), 'utf8'),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanelChrome.tsx'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src', 'locales', 'en.json'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'locales', 'zh.json'), 'utf8'),
  ]);
  const states = [
    'retained_live_host',
    'retained_inspection_unknown',
    'retained_profile_lock',
    'retained_unknown_or_external_owner',
    'retained_profile_unavailable',
    'recovered_launch_pending',
    'recovered_runtime_owned',
    'removed_finished_record',
    'renderer_process_terminated',
  ];
  for (const state of states) assert.match(ipcSource, new RegExp(`'${state}'`));
  assert.match(panelSource, /snapshot\.recovery_states/);
  assert.match(panelSource, /data-ccem-browser-recovery=/);
  assert.match(panelSource, /recoveryStates=\{recoveryStates\}/);
  assert.match(chromeSource, /data-ccem-browser-recovery-status=/);
  assert.match(chromeSource, /recoveryStates[\s\S]*\.map\(\(state\) => t\(recoveryStateTranslationKeys\[state\]\)\)[\s\S]*\.join\(', '\)/);
  assert.doesNotMatch(chromeSource, /\{recoveryStates\.join\(/);

  const en = JSON.parse(enRaw);
  const zh = JSON.parse(zhRaw);
  const translationKeys = [
    'browserRecoveryRecovered',
    'browserRecoveryAttention',
    'browserRecoveryRetainedLiveHost',
    'browserRecoveryInspectionUnknown',
    'browserRecoveryProfileLock',
    'browserRecoveryUnknownOwner',
    'browserRecoveryProfileUnavailable',
    'browserRecoveryLaunchRecovered',
    'browserRecoveryRuntimeRecovered',
    'browserRecoveryRecordCleared',
    'browserRecoveryRendererStopped',
  ];
  for (const key of translationKeys) {
    assert.equal(typeof en.workspace[key], 'string');
    assert.equal(typeof zh.workspace[key], 'string');
  }
  assert.match(en.workspace.browserRecoveryRecovered, /\{state\}/);
  assert.match(zh.workspace.browserRecoveryRecovered, /\{state\}/);
  assert.match(en.workspace.browserRecoveryAttention, /\{state\}/);
  assert.match(zh.workspace.browserRecoveryAttention, /\{state\}/);
});

test('panel source exposes only Mode 2 lease commands through one ordering lane', async () => {
  const [
    panelSource,
    panelChromeSource,
    geometrySyncSource,
    workspaceSource,
  ] = await Promise.all([
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanelChrome.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'hooks', 'useNativeBrowserSurfaceGeometrySync.ts'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'), 'utf8'),
  ]);

  assert.match(panelSource, /data-ccem-browser-backend="login"/);
  assert.match(panelSource, /browser_surface_state_changed/);
  assert.match(panelSource, /BROWSER_SURFACE_HOST_SHORTCUT_EVENT/);
  assert.match(panelSource, /browserSurfaceHostShortcutMatchesLease\(/);
  assert.match(panelSource, /onHostShortcutRef\.current\?\.\(event\.payload\.action\)/);
  assert.match(
    panelSource,
    /browserSurfaceEventMatchesLease\(lease, state\)/,
  );
  assert.match(
    panelSource,
    /surfaceOrdering\.enqueue\(\(clientRevision\) => \([\s\S]*browserSurfaceClient\.acquire\(\{ \.\.\.acquireRequest, clientRevision \}\)/,
  );
  assert.doesNotMatch(panelSource, /disposition: 'hide'/);
  assert.match(
    panelSource,
    /await surfaceOrdering\.enqueue\(\(clientRevision\) => \([\s\S]*browserSurfaceClient\.release\(\{[\s\S]*disposition: 'close'/,
  );
  assert.match(panelSource, /browserSurfaceClient\.navigate/);
  assert.match(panelSource, /browserSurfaceClient\.navigationAction/);
  assert.match(
    panelSource,
    /const visible = requestedVisible[\s\S]*&& !surfaceOccludedRef\.current[\s\S]*&& !nativeSurfaceOcclusionStore\.isOccluded\(\)/,
  );
  assert.doesNotMatch(panelSource, /focused:/);
  assert.doesNotMatch(panelSource, /document\.hasFocus\(\)/);
  assert.doesNotMatch(panelSource, /window\.addEventListener\(['"]focus['"]/);
  assert.match(panelSource, /useNativeBrowserSurfaceGeometrySync\(frameRef, syncBounds, isActiveSurface\)/);
  assert.match(geometrySyncSource, /getCurrentWindow\(\)/);
  assert.match(
    geometrySyncSource,
    /currentWindow\.onMoved\(syncBounds\)[\s\S]*currentWindow\.onResized\(syncBounds\)[\s\S]*currentWindow\.onScaleChanged\(syncBounds\)[\s\S]*currentWindow\.onFocusChanged\(syncBounds\)/,
  );
  assert.match(
    geometrySyncSource,
    /nativeWindowUnlisteners\.forEach\(\(unlisten\) => unlisten\(\)\)/,
  );
  assert.match(geometrySyncSource, /observer\.disconnect\(\)/);
  assert.match(panelSource, /data-ccem-browser-occluded=\{surfaceOccluded \? 'true' : 'false'\}/);
  assert.match(panelSource, /<BrowserPanelNavigation/);
  assert.match(panelChromeSource, /ArrowLeft/);
  assert.match(panelChromeSource, /ArrowRight/);
  assert.match(panelChromeSource, /RefreshCw/);
  assert.match(panelChromeSource, /workspace\.browserBack/);
  assert.match(panelChromeSource, /workspace\.browserForward/);
  assert.match(panelChromeSource, /workspace\.browserReload/);
  assert.match(panelSource, /control !== 'user'/);
  assert.match(panelChromeSource, /disabled=\{navigationDisabled\}/);
  assert.match(workspaceSource, /browserTargetBySessionId/);
  assert.match(
    workspaceSource,
    /browserSurfaceOccluded = !isActive[\s\S]*\|\| isGlobalSearchOpen[\s\S]*\|\| nativeSurfaceModalOccluded/,
  );
  assert.match(workspaceSource, /surfaceOccluded: browserSurfaceOccluded \|\| !isPanelActive/);
  assert.match(workspaceSource, /onHostShortcut: handleBrowserSurfaceHostShortcut/);
  assert.match(workspaceSource, /case 'open_search':[\s\S]*handleOpenSearchShortcut\(\)/);
  assert.match(workspaceSource, /case 'open_project':[\s\S]*handleOpenProjectShortcut\(\)/);
  assert.match(workspaceSource, /case 'submit':[\s\S]*handleWorkspaceSubmitShortcut\(\)/);
  assert.match(workspaceSource, /case 'escape':[\s\S]*handleWorkspaceEscapeShortcut\(\)/);
  assert.doesNotMatch(workspaceSource, /browser_panel_requested|backend=["']preview["']/i);

  const listenerIndex = panelSource.indexOf("'browser_surface_state_changed'");
  const hostShortcutListenerIndex = panelSource.indexOf(
    'BROWSER_SURFACE_HOST_SHORTCUT_EVENT',
    listenerIndex,
  );
  const acquireIndex = panelSource.indexOf(
    'browserSurfaceClient.acquire({ ...acquireRequest, clientRevision })',
  );
  assert.ok(listenerIndex > 0);
  assert.ok(hostShortcutListenerIndex > listenerIndex);
  assert.ok(acquireIndex > listenerIndex, 'surface listener must be ready before acquire');
  assert.ok(
    acquireIndex > hostShortcutListenerIndex,
    'host shortcut listener must be ready before acquire',
  );
  assert.match(panelSource, /pendingStates\.push\(event\.payload\)/);
  assert.match(panelSource, /createBrowserSurfaceOrdering\(\)/);
  assert.match(panelSource, /surfaceOrdering\.enqueue\(/);
  assert.match(panelSource, /state\.server_sequence/);
  assert.doesNotMatch(panelSource, /nextSurfaceRevision/);

  const panelAst = ts.createSourceFile(
    'BrowserPanel.tsx',
    panelSource,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const orderedMethods = new Set([
    'acquire', 'sync', 'release', 'navigate', 'navigationAction', 'control', 'closePopup',
  ]);
  const surfaceCalls = [];
  const unlanedCalls = [];
  const inspectSurfaceCalls = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(panelAst) === 'browserSurfaceClient'
      && orderedMethods.has(node.expression.name.text)
    ) {
      surfaceCalls.push(node.expression.name.text);
      let ancestor = node.parent;
      while (ancestor && !(
        ts.isCallExpression(ancestor)
        && ts.isPropertyAccessExpression(ancestor.expression)
        && ancestor.expression.getText(panelAst) === 'surfaceOrdering.enqueue'
      )) {
        ancestor = ancestor.parent;
      }
      if (!ancestor) unlanedCalls.push(node.expression.name.text);
    }
    ts.forEachChild(node, inspectSurfaceCalls);
  };
  inspectSurfaceCalls(panelAst);
  assert.ok(surfaceCalls.length >= 9);
  assert.deepEqual(unlanedCalls, [], 'every Mode 2 surface mutation must use one ordering lane');
  assert.equal(
    panelSource.match(/applyBrowserSurfaceMutationResponseForLease\(/g)?.length,
    4,
    'occlusion, navigation action, control, and popup responses must bind exact lease identity',
  );

  const navigationActionStart = panelSource.indexOf('const handleNavigationAction');
  const navigationActionEnd = panelSource.indexOf('const handleSubmit', navigationActionStart);
  const navigationAction = panelSource.slice(navigationActionStart, navigationActionEnd);
  assert.ok(navigationActionStart > 0 && navigationActionEnd > navigationActionStart);
  assert.match(navigationAction, /surfaceOrdering\.enqueue\(/);
  assert.match(navigationAction, /surfaceLeaseRef\.current/);
  assert.match(navigationAction, /isActiveSurfaceRef\.current/);
  assert.match(navigationAction, /surfaceOccludedRef\.current/);
  assert.match(navigationAction, /nativeSurfaceOcclusionStore\.isOccluded\(\)/);
  assert.match(navigationAction, /popupActiveRef\.current/);
  assert.match(navigationAction, /sessionStatusRef\.current !== 'running'/);
  assert.match(navigationAction, /lifecycleRef\.current !== 'ready'/);
  assert.match(navigationAction, /isLoadingRef\.current/);
  assert.match(navigationAction, /surfaceClosingRef\.current/);

  const replayIndex = panelSource.indexOf(
    'highestSequencedSurfaceEventForLease(',
    acquireIndex,
  );
  assert.ok(replayIndex > acquireIndex, 'pending state must replay by the highest server sequence');

  const closeReleaseIndex = panelSource.indexOf("disposition: 'close'");
  const closeSucceededIndex = panelSource.indexOf(
    'surfaceCloseSucceededRef.current = true',
    closeReleaseIndex,
  );
  const closeCallbackIndex = panelSource.indexOf('onClose();', closeSucceededIndex);
  assert.ok(closeReleaseIndex > 0);
  assert.ok(closeSucceededIndex > closeReleaseIndex, 'close must finish before marking the lease closed');
  assert.ok(closeCallbackIndex > closeSucceededIndex, 'panel closes only after native close succeeds');
  assert.match(
    panelSource,
    /catch \(closeError\) \{[\s\S]*showBrowserError\(String\(closeError\)\);[\s\S]*setIsClosingSurface\(false\);/,
  );
  assert.match(
    panelSource,
    /if \(lease && !surfaceCloseSucceededRef\.current\) \{[\s\S]*disposition: 'close'/,
  );
  assert.match(panelSource, /onClose=\{\(\) => void handleClose\(\)\}/);
  assert.doesNotMatch(panelSource, /label=\{t\('workspace\.browserClose'\)\}[\s\S]{0,120}onClick=\{onClose\}/);
});
