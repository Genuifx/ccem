import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importPresentationRevision() {
  const source = await fs.readFile(
    path.join(
      desktopDir,
      'src',
      'components',
      'workspace',
      'browserPresentationRevision.ts',
    ),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-presentation-revision-'));
  const outputPath = path.join(tempDir, 'browserPresentationRevision.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('A login to B preview to A login gives every same-render visibility mutation one monotonic epoch', async () => {
  const { createBrowserPresentationRevisionAllocator } = await importPresentationRevision();
  const allocator = createBrowserPresentationRevisionAllocator();
  const aVisible = {
    ownerSessionId: 'runtime:a',
    surfaceSessionId: 'runtime:a:1',
    backend: 'login',
    occluded: false,
  };
  const bVisible = {
    ownerSessionId: 'runtime:b',
    surfaceSessionId: 'runtime:b:2',
    backend: 'preview',
    occluded: false,
  };
  const bOccluded = { ...bVisible, occluded: true };

  const firstARevision = allocator.observe(aVisible);
  assert.equal(allocator.observe(aVisible), firstARevision);

  const switchToBRevision = allocator.observe(bVisible);
  const staleAHideRevision = switchToBRevision;
  const targetBShowRevision = switchToBRevision;
  assert.equal(switchToBRevision, firstARevision + 1);
  assert.equal(staleAHideRevision, targetBShowRevision);

  const switchBackToARevision = allocator.observe(aVisible);
  const staleBHideRevision = switchBackToARevision;
  const targetAShowRevision = switchBackToARevision;
  assert.equal(switchBackToARevision, switchToBRevision + 1);
  assert.equal(staleBHideRevision, targetAShowRevision);

  assert.equal(allocator.observe(bOccluded), switchBackToARevision + 1);
  assert.equal(allocator.observe(bOccluded), switchBackToARevision + 1);
});

test('Workspace propagates one epoch to every panel and login sync captures that epoch', async () => {
  const [workspace, panel, previewMutationHook, ipc] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'), 'utf8'),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'hooks', 'usePreviewSurfaceMutation.ts'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src', 'lib', 'browserSurfaceIpc.ts'), 'utf8'),
  ]);

  assert.match(workspace, /browserPresentationRevisionAllocatorRef\.current\.observe\(\{/);
  assert.match(workspace, /presentationRevision: browserPresentationRevision,/);
  assert.match(
    panel,
    /requestedPresentationRevision: number,[\s\S]*presentationRevision: requestedPresentationRevision/,
  );
  assert.match(panel, /await syncLoginSurface\(visible, presentationRevision\)/);
  assert.match(
    panel,
    /loginLifecycleActionsRef\.current\.syncLoginSurface\(\s*true,\s*presentationRevisionRef\.current,/,
  );
  assert.match(
    panel,
    /browser_set_visible', \{[\s\S]*visible,[\s\S]*presentationRevision/,
  );
  assert.match(
    workspace,
    /browser_set_active_session', \{[\s\S]*presentationRevision: browserPresentationRevision/,
  );
  assert.match(
    previewMutationHook,
    /presentationRevision: retirementPresentationRevision/,
  );
  assert.match(ipc, /presentationRevision: number;/);
});

test('login acquire lifetime stays stable across active, occlusion, and presentation updates', async () => {
  const panel = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
    'utf8',
  );
  const acquireStart = panel.indexOf("  useEffect(() => {\n    if (backend !== 'login') return;");
  const nextEffect = panel.indexOf("\n\n  useEffect(() => {\n    if (backend !== 'preview') return;", acquireStart);
  assert.notEqual(acquireStart, -1, 'login acquire effect should exist');
  assert.notEqual(nextEffect, -1, 'login acquire effect should end before preview listener effect');

  const acquireEffect = panel.slice(acquireStart, nextEffect);
  const dependencyStart = acquireEffect.lastIndexOf('  }, [');
  assert.notEqual(dependencyStart, -1, 'login acquire effect should have an explicit dependency list');
  const dependencyList = acquireEffect.slice(dependencyStart);
  assert.doesNotMatch(
    dependencyList,
    /presentationRevision|isActiveSurface|surfaceOccluded|applySurfaceSnapshot|readViewport|showBrowserError|syncLoginSurface|\bt\b/,
  );
  assert.match(
    dependencyList,
    /\[\s*backend,\s*loginProfileId,\s*loginProfileMode,\s*loginWorkingDir,\s*sessionId,\s*\]/,
  );
  assert.match(
    acquireEffect,
    /loginLifecycleActionsRef\.current\.syncLoginSurface\(\s*true,\s*presentationRevisionRef\.current,/,
  );

  const syncCallbackStart = panel.indexOf('  const syncLoginSurface = useCallback(');
  const syncCallbackEnd = panel.indexOf('\n\n  const setNativeSurfaceVisible', syncCallbackStart);
  const syncCallback = panel.slice(syncCallbackStart, syncCallbackEnd);
  assert.match(syncCallback, /\}, \[loginSurfaceOrdering, readViewport\]\);/);
});
