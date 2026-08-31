import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importBrowserPanelTarget() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'workspace',
    'browserPanelTarget.ts',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-browser-panel-target-'));
  const outputPath = path.join(tempDir, 'browserPanelTarget.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('a late provider id and live/history round trip retain one browser instance key', async () => {
  const {
    createBrowserPanelSessionKeyRegistry,
    createBrowserPanelSurfaceSessionId,
    rebindBrowserPanelTarget,
    WORKSPACE_BROWSER_COMPOSE_SESSION_ID,
  } = await importBrowserPanelTarget();
  const registry = createBrowserPanelSessionKeyRegistry();

  const beforeProviderId = registry.resolveLive({
    provider: 'claude',
    providerSessionId: null,
    runtimeId: 'runtime-a',
  });
  const afterProviderId = registry.resolveLive({
    provider: 'claude',
    providerSessionId: 'provider-a',
    runtimeId: 'runtime-a',
  });
  const historyRoundTrip = registry.resolveHistory({
    provider: 'claude',
    providerSessionId: 'provider-a',
    matchingLiveSession: {
      provider: 'claude',
      providerSessionId: 'provider-a',
      runtimeId: 'runtime-a',
    },
  });

  assert.equal(beforeProviderId, 'runtime:runtime-a');
  assert.equal(afterProviderId, beforeProviderId);
  assert.equal(historyRoundTrip, beforeProviderId);
  assert.equal(WORKSPACE_BROWSER_COMPOSE_SESSION_ID, 'draft:workspace');

  const draftTarget = {
    backend: 'login',
    instanceId: 7,
    surfaceSessionId: createBrowserPanelSurfaceSessionId(
      WORKSPACE_BROWSER_COMPOSE_SESSION_ID,
      7,
    ),
    workingDir: '/workspace',
    profileMode: 'default',
  };
  const reboundTargets = rebindBrowserPanelTarget(
    { [WORKSPACE_BROWSER_COMPOSE_SESSION_ID]: draftTarget },
    WORKSPACE_BROWSER_COMPOSE_SESSION_ID,
    beforeProviderId,
  );
  assert.equal(reboundTargets[WORKSPACE_BROWSER_COMPOSE_SESSION_ID], undefined);
  assert.equal(reboundTargets[beforeProviderId], draftTarget);
  assert.equal(reboundTargets[beforeProviderId].surfaceSessionId, 'draft:workspace:7');
});

test('runtime-addressed history reuses the live browser only for the same provider and working directory', async () => {
  const {
    createBrowserPanelSessionKeyRegistry,
    matchesBrowserPanelHistorySession,
  } = await importBrowserPanelTarget();
  const registry = createBrowserPanelSessionKeyRegistry();
  const historySession = {
    source: 'claude',
    id: 'native-runtime-a',
    project: '/workspace/project',
  };
  const matchingRuntime = {
    provider: 'claude',
    provider_session_id: null,
    project_dir: '/workspace/project/',
    runtime_id: 'native-runtime-a',
  };

  const liveKey = registry.resolveLive({
    provider: matchingRuntime.provider,
    providerSessionId: matchingRuntime.provider_session_id,
    runtimeId: matchingRuntime.runtime_id,
  });
  assert.equal(liveKey, 'runtime:native-runtime-a');
  assert.equal(matchesBrowserPanelHistorySession(historySession, matchingRuntime), true);
  assert.equal(
    registry.resolveHistory({
      provider: historySession.source,
      providerSessionId: historySession.id,
      matchingLiveSession: {
        provider: matchingRuntime.provider,
        providerSessionId: matchingRuntime.provider_session_id,
        runtimeId: matchingRuntime.runtime_id,
      },
    }),
    liveKey,
    'live to runtime-addressed history and back must retain one BrowserPanel key',
  );
  assert.equal(
    matchesBrowserPanelHistorySession(
      historySession,
      { ...matchingRuntime, project_dir: '/workspace/other-project' },
    ),
    false,
    'the same runtime id in another working directory must not capture this browser',
  );
  assert.equal(
    matchesBrowserPanelHistorySession(
      historySession,
      { ...matchingRuntime, provider: 'codex' },
    ),
    false,
    'the same runtime id from another provider must not capture this browser',
  );
});

test('history handoff uses only the exact active native runtime selected for that history record', async () => {
  const { resolveHistoryBrowserAgentSessionId } = await importBrowserPanelTarget();
  const historySession = {
    source: 'claude',
    id: 'provider-a',
    project: '/workspace/project',
  };
  const exactActiveRuntime = {
    provider: 'claude',
    provider_session_id: 'provider-a',
    project_dir: '/workspace/project/',
    runtime_id: 'native-runtime-a',
    status: 'ready',
    is_active: true,
  };

  assert.equal(
    resolveHistoryBrowserAgentSessionId(historySession, exactActiveRuntime),
    'native-runtime-a',
  );
  assert.equal(
    resolveHistoryBrowserAgentSessionId(
      { ...historySession, id: 'native-runtime-a' },
      { ...exactActiveRuntime, provider_session_id: null },
    ),
    'native-runtime-a',
    'runtime-addressed history links bind the same exact native actor',
  );
  assert.equal(
    resolveHistoryBrowserAgentSessionId(
      historySession,
      { ...exactActiveRuntime, provider: 'codex' },
    ),
    null,
    'a runtime from another provider must not become the handoff actor',
  );
  assert.equal(
    resolveHistoryBrowserAgentSessionId(
      historySession,
      { ...exactActiveRuntime, provider_session_id: 'provider-b' },
    ),
    null,
    'a runtime from another provider session must not become the handoff actor',
  );
  assert.equal(
    resolveHistoryBrowserAgentSessionId(
      historySession,
      { ...exactActiveRuntime, project_dir: '/workspace/other-project' },
    ),
    null,
    'provider ids are not authoritative across working directories',
  );
  assert.equal(
    resolveHistoryBrowserAgentSessionId(
      historySession,
      { ...exactActiveRuntime, status: 'stopped', is_active: false },
    ),
    null,
    'terminal runtimes must not remain eligible for handoff',
  );
  for (const terminalStatus of ['handoff_closing', 'app_closing']) {
    assert.equal(
      resolveHistoryBrowserAgentSessionId(
        historySession,
        { ...exactActiveRuntime, status: terminalStatus },
      ),
      null,
      `${terminalStatus} is already terminal for browser actor lookup`,
    );
  }
});

test('only a runtime with the embedded browser MCP can become the browser Agent', async () => {
  const {
    resolveActiveBrowserAgentSessionId,
    resolveHistoryBrowserAgentSessionId,
  } = await importBrowserPanelTarget();
  const activeRuntime = {
    provider: 'claude',
    provider_session_id: 'provider-a',
    project_dir: '/workspace/project',
    runtime_id: 'native-runtime-a',
    status: 'ready',
    is_active: true,
  };

  assert.equal(resolveActiveBrowserAgentSessionId(activeRuntime), 'native-runtime-a');
  for (const provider of ['codex', 'opencode']) {
    const unsupportedRuntime = { ...activeRuntime, provider };
    assert.equal(
      resolveActiveBrowserAgentSessionId(unsupportedRuntime),
      null,
      `${provider} must stay in User control without ccem-browser tools`,
    );
    assert.equal(
      resolveHistoryBrowserAgentSessionId(
        {
          source: provider,
          id: unsupportedRuntime.provider_session_id,
          project: unsupportedRuntime.project_dir,
        },
        unsupportedRuntime,
      ),
      null,
      `${provider} history must not present a fake Agent handoff`,
    );
  }
});

test('closed Browser toggle creates default Mode 2 once, then only hides and shows that lease', async () => {
  const {
    isBrowserPanelTargetVisible,
    retireBrowserPanelTargetForWorkingDirChange,
    toggleDefaultBrowserPanelTarget,
  } = await importBrowserPanelTarget();
  let nextInstanceId = 40;
  let allocations = 0;
  const allocate = () => {
    allocations += 1;
    nextInstanceId += 1;
    return nextInstanceId;
  };

  const opened = toggleDefaultBrowserPanelTarget({}, 'claude:conversation-a', '/workspace-a', allocate);
  const firstTarget = opened['claude:conversation-a'];
  assert.deepEqual(firstTarget, {
    backend: 'login',
    instanceId: 41,
    surfaceSessionId: 'claude:conversation-a:41',
    visible: true,
    workingDir: '/workspace-a',
    profileMode: 'default',
  });
  assert.equal(allocations, 1);

  const hidden = toggleDefaultBrowserPanelTarget(
    opened,
    'claude:conversation-a',
    '/workspace-a',
    allocate,
  );
  const hiddenTarget = hidden['claude:conversation-a'];
  assert.equal(isBrowserPanelTargetVisible(hiddenTarget), false);
  assert.equal(hiddenTarget.instanceId, firstTarget.instanceId);
  assert.equal(hiddenTarget.surfaceSessionId, firstTarget.surfaceSessionId);
  assert.equal(allocations, 1, 'hiding must not allocate another browser instance');

  const shown = toggleDefaultBrowserPanelTarget(
    hidden,
    'claude:conversation-a',
    '/workspace-a',
    allocate,
  );
  assert.equal(isBrowserPanelTargetVisible(shown['claude:conversation-a']), true);
  assert.equal(shown['claude:conversation-a'].instanceId, firstTarget.instanceId);
  assert.equal(allocations, 1, 'showing must not allocate another browser instance');

  const withConversationB = toggleDefaultBrowserPanelTarget(
    shown,
    'claude:conversation-b',
    '/workspace-b',
    allocate,
  );
  assert.equal(withConversationB['claude:conversation-a'].instanceId, 41);
  assert.equal(withConversationB['claude:conversation-b'].instanceId, 42);
  assert.equal(withConversationB['claude:conversation-b'].profileMode, 'default');

  const retired = retireBrowserPanelTargetForWorkingDirChange(
    withConversationB,
    'claude:conversation-a',
    '/workspace-c',
  );
  assert.equal(retired['claude:conversation-a'], undefined);
  assert.equal(retired['claude:conversation-b'].instanceId, 42);

  const racedToggle = toggleDefaultBrowserPanelTarget(
    shown,
    'claude:conversation-a',
    '/workspace-c',
    allocate,
  );
  assert.equal(racedToggle, shown, 'a stale working-directory lease must never be repurposed');
  assert.equal(allocations, 2);
});

test('Workspace retains inactive Mode 2 panels and wires the status button to the default toggle', async () => {
  const workspaceSource = await fs.readFile(
    path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'),
    'utf8',
  );
  const commandHookSource = await fs.readFile(
    path.join(desktopDir, 'src', 'hooks', 'useTauriCommands.ts'),
    'utf8',
  );
  const tauriIpcSource = await fs.readFile(
    path.join(desktopDir, 'src', 'lib', 'tauri-ipc.ts'),
    'utf8',
  );

  assert.match(workspaceSource, /Object\.entries\(browserTargetBySessionId\)\.map/);
  assert.match(workspaceSource, /const panelKey = String\(target\.instanceId\);/);
  assert.match(workspaceSource, /sessionId: target\.surfaceSessionId,/);
  assert.match(workspaceSource, /isActiveSurface: isPanelActive/);
  assert.match(workspaceSource, /isPanelActive \? 'flex' : 'hidden'/);
  assert.match(workspaceSource, /onClose: \(\) => closeBrowserPanel\(sessionId\)/);
  assert.match(workspaceSource, /delete next\[sessionId\]/);
  assert.match(
    workspaceSource,
    /onToggleBrowser=\{\(\) => toggleActiveBrowser\(skillsContext\.workingDir\)\}/,
  );
  assert.match(
    workspaceSource,
    /toggleDefaultBrowserPanelTarget\([\s\S]*activeBrowserSessionId,[\s\S]*workingDir,[\s\S]*browserPanelInstanceSeqRef\.current \+= 1/,
  );
  assert.match(
    workspaceSource,
    /retireBrowserPanelTargetForWorkingDirChange\([\s\S]*WORKSPACE_BROWSER_COMPOSE_SESSION_ID,[\s\S]*skillsContext\.workingDir/,
  );
  assert.match(
    workspaceSource,
    /rebindBrowserPanelTarget\([\s\S]*WORKSPACE_BROWSER_COMPOSE_SESSION_ID,[\s\S]*liveBrowserSessionId/,
  );
  assert.doesNotMatch(workspaceSource, /deferInitialTurn|onAgentHandoff/);
  assert.doesNotMatch(commandHookSource, /deferInitialTurn|start_native_session_initial_turn/);
  assert.doesNotMatch(tauriIpcSource, /start_native_session_initial_turn/);
  assert.doesNotMatch(workspaceSource, /browser_panel_requested|backend=["']preview["']/i);
});

test('Workspace binds an exact active native history selection as the browser handoff actor without leaving history', async () => {
  const workspaceSource = await fs.readFile(
    path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'),
    'utf8',
  );

  assert.match(workspaceSource, /const \[selectedHistoryNativeRuntimeId, setSelectedHistoryNativeRuntimeId\] = useState/);
  assert.match(workspaceSource, /setSelectedHistoryNativeRuntimeId\(null\);[\s\S]*const nativeHistorySession/);
  assert.match(
    workspaceSource,
    /const historyBrowserAgentSessionId = resolveHistoryBrowserAgentSessionId\([\s\S]*session,[\s\S]*nativeHistorySession,[\s\S]*\);/,
  );
  assert.match(
    workspaceSource,
    /if \(historyBrowserAgentSessionId && nativeHistorySession\) \{[\s\S]*upsertLiveSessionEntry\(nativeHistorySession\);[\s\S]*setSelectedHistoryNativeRuntimeId\(historyBrowserAgentSessionId\);[\s\S]*\}/,
  );
  assert.match(
    workspaceSource,
    /workspaceMode === 'history'[\s\S]*resolveHistoryBrowserAgentSessionId\([\s\S]*selectedSession,[\s\S]*selectedHistoryNativeSession,[\s\S]*\)/,
  );
});

test('inactive panels hide without bounds, and only the active surface observes geometry or overlays', async () => {
  const [panelSource, geometrySource, occlusionSource] = await Promise.all([
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'hooks', 'useNativeBrowserSurfaceGeometrySync.ts'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src', 'lib', 'nativeSurfaceOcclusion.ts'), 'utf8'),
  ]);

  assert.match(panelSource, /const viewport = visible \? readViewport\(\) : undefined;/);
  assert.match(panelSource, /if \(!lease \|\| \(visible && !viewport\)\) return;/);
  assert.match(panelSource, /\.\.\.\(viewport \? \{ viewport \} : \{\}\)/);
  assert.match(panelSource, /useNativeBrowserSurfaceGeometrySync\(frameRef, syncBounds, isActiveSurface\)/);
  assert.match(panelSource, /useNativeSurfaceOcclusionParticipant\([\s\S]*\), isActiveSurface\);/);
  assert.match(panelSource, /occlude: occludeSurface/);
  assert.match(
    panelSource,
    /disposed[\s\S]*!isActiveSurfaceRef\.current[\s\S]*!browserSurfaceHostShortcutMatchesLease/,
  );
  assert.match(geometrySource, /if \(!enabled\) return undefined;/);
  assert.match(occlusionSource, /if \(!active\) return undefined;/);
});
