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
  assert.doesNotMatch(workspaceSource, /browser_panel_requested|backend=["']preview["']/i);
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
