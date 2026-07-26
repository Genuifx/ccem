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
    createBrowserPanelSurfaceSessionId,
    createBrowserPanelSessionKeyRegistry,
    findBrowserPanelOwnerSessionIdBySurfaceSessionId,
    isBrowserPanelTargetVisible,
    rebindBrowserPanelTarget,
    setBrowserPanelTargetVisible,
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
  const historyAfterRuntimeRemoval = registry.resolveHistory({
    provider: 'claude',
    providerSessionId: 'provider-a',
    matchingLiveSession: null,
  });
  const restoredWithProviderId = registry.resolveLive({
    provider: 'claude',
    providerSessionId: 'provider-b',
    runtimeId: 'runtime-b',
  });

  assert.equal(beforeProviderId, 'runtime:runtime-a');
  assert.equal(afterProviderId, beforeProviderId);
  assert.equal(historyRoundTrip, beforeProviderId);
  assert.equal(historyAfterRuntimeRemoval, beforeProviderId);
  assert.equal(restoredWithProviderId, 'claude:provider-b');
  assert.equal(WORKSPACE_BROWSER_COMPOSE_SESSION_ID, 'draft:workspace');

  const previewTarget = {
    backend: 'preview',
    instanceId: 6,
    surfaceSessionId: createBrowserPanelSurfaceSessionId('runtime:retained', 6),
  };
  const hiddenPreviewTarget = setBrowserPanelTargetVisible(previewTarget, false);
  const shownPreviewTarget = setBrowserPanelTargetVisible(hiddenPreviewTarget, true);
  assert.equal(isBrowserPanelTargetVisible(previewTarget), true);
  assert.equal(isBrowserPanelTargetVisible(hiddenPreviewTarget), false);
  assert.equal(isBrowserPanelTargetVisible(shownPreviewTarget), true);
  assert.equal(shownPreviewTarget.instanceId, previewTarget.instanceId);
  assert.equal(shownPreviewTarget.surfaceSessionId, previewTarget.surfaceSessionId);

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
  assert.equal(
    reboundTargets[beforeProviderId].surfaceSessionId,
    'draft:workspace:7',
  );
  assert.equal(
    createBrowserPanelSurfaceSessionId(WORKSPACE_BROWSER_COMPOSE_SESSION_ID, 8),
    'draft:workspace:8',
  );
  assert.notEqual(
    createBrowserPanelSurfaceSessionId(WORKSPACE_BROWSER_COMPOSE_SESSION_ID, 8),
    reboundTargets[beforeProviderId].surfaceSessionId,
  );
  assert.equal(
    createBrowserPanelSurfaceSessionId('claude:provider-a', 9),
    'claude:provider-a:9',
  );
  assert.notEqual(
    createBrowserPanelSurfaceSessionId('claude:provider-a', 9),
    createBrowserPanelSurfaceSessionId('claude:provider-a', 10),
    'closing then reopening a live owner must not reuse its native surface id',
  );

  const reboundPreviewTargets = rebindBrowserPanelTarget(
    {
      [WORKSPACE_BROWSER_COMPOSE_SESSION_ID]: {
        backend: 'preview',
        instanceId: 11,
        surfaceSessionId: createBrowserPanelSurfaceSessionId(
          WORKSPACE_BROWSER_COMPOSE_SESSION_ID,
          11,
        ),
      },
    },
    WORKSPACE_BROWSER_COMPOSE_SESSION_ID,
    beforeProviderId,
  );
  assert.equal(
    findBrowserPanelOwnerSessionIdBySurfaceSessionId(
      reboundPreviewTargets,
      'draft:workspace:11',
    ),
    beforeProviderId,
    'agent_reveal from the retained native preview must resolve its rebound owner',
  );
});

test('Workspace keeps A and B mounted while switching, and reuses an existing login panel', async () => {
  const workspaceSource = await fs.readFile(
    path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'),
    'utf8',
  );

  assert.match(workspaceSource, /Object\.entries\(browserTargetBySessionId\)\.map/);
  assert.match(workspaceSource, /const panelKey = String\(target\.instanceId\);/);
  assert.match(workspaceSource, /sessionId: target\.surfaceSessionId,/);
  assert.match(workspaceSource, /isActiveSurface: isPanelActive/);
  assert.match(workspaceSource, /isPanelActive \? 'flex' : 'hidden'/);
  assert.match(workspaceSource, /const activeBrowserSurfaceSessionId = activeVisibleBrowserTarget\?\.surfaceSessionId \?\? null/);
  assert.match(workspaceSource, /if \(!activeBrowserSurfaceSessionId\) \{\s*return;\s*\}/);
  assert.match(workspaceSource, /onClose: \(\) => closeBrowserPanel\(sessionId\)/);
  assert.match(workspaceSource, /delete next\[sessionId\]/);
  assert.match(workspaceSource, /rebindBrowserPanelTarget\([\s\S]*WORKSPACE_BROWSER_COMPOSE_SESSION_ID,[\s\S]*liveBrowserSessionId/);
  assert.match(
    workspaceSource,
    /findBrowserPanelOwnerSessionIdBySurfaceSessionId\(previous, requestedSurfaceSessionId\)/,
  );
  assert.doesNotMatch(workspaceSource, /key=\{`\$\{sessionId\}:\$\{target\.requestId\}`\}/);

  const openLoginStart = workspaceSource.indexOf('const openActiveLoginBrowser = useCallback');
  const openLoginEnd = workspaceSource.indexOf('\n\n  useEffect(() => {', openLoginStart);
  const openLoginSource = workspaceSource.slice(openLoginStart, openLoginEnd);
  assert.match(openLoginSource, /if \(existing\) \{[\s\S]*navigationRequestId:[\s\S]*navigationUrl: request\.initialUrl/);
  assert.match(openLoginSource, /setBrowserPanelTargetVisible\(existing, true\)/);
  assert.match(openLoginSource, /\.\.\.visibleExisting,/);
  assert.match(openLoginSource, /const instanceId = browserPanelInstanceSeqRef\.current \+= 1;/);
  assert.match(
    openLoginSource,
    /surfaceSessionId: createBrowserPanelSurfaceSessionId\(activeBrowserSessionId, instanceId\)/,
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
  assert.match(
    panelSource,
    /disposed[\s\S]*!isActiveSurfaceRef\.current[\s\S]*!browserSurfaceHostShortcutMatchesLease/,
  );
  assert.match(geometrySource, /if \(!enabled\) return undefined;/);
  assert.match(occlusionSource, /if \(!active\) return undefined;/);
});

test('a post-acquire URL request navigates instead of restarting the panel lease', async () => {
  const panelSource = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
    'utf8',
  );
  const loginAcquireStart = panelSource.indexOf("if (backend !== 'login') return;");
  const loginAcquireEnd = panelSource.indexOf("useEffect(() => {\n    if (backend !== 'preview') return;", loginAcquireStart);
  const loginAcquireSource = panelSource.slice(loginAcquireStart, loginAcquireEnd);

  assert.match(panelSource, /const initialUrlRef = useRef\(defaultUrl\);/);
  assert.match(loginAcquireSource, /initialUrl: initialUrlRef\.current/);
  assert.doesNotMatch(loginAcquireSource, /defaultUrl/);
  assert.match(
    panelSource,
    /navigationRequestId == null[\s\S]*!isSurfaceReady[\s\S]*handledNavigationRequestIdRef\.current = navigationRequestId;[\s\S]*void navigate\(navigationUrl\);/,
  );
});
