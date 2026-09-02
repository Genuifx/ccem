import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

function normalizeRepoText(source) {
  return source.replace(/\r\n?/g, '\n');
}

async function readRepoText(...parts) {
  return normalizeRepoText(await fs.readFile(path.join(desktopDir, ...parts), 'utf8'));
}

test('repo source reader normalizes CRLF and lone CR boundaries', () => {
  assert.equal(normalizeRepoText('before\r\nmarker\rafter'), 'before\nmarker\nafter');
});

async function importPresentationRevision() {
  const source = await readRepoText(
    'src',
    'components',
    'workspace',
    'browserPresentationRevision.ts',
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

test('A to B to A gives every same-render Mode 2 visibility mutation one monotonic epoch', async () => {
  const { createBrowserPresentationRevisionAllocator } = await importPresentationRevision();
  const allocator = createBrowserPresentationRevisionAllocator();
  const aVisible = {
    ownerSessionId: 'runtime:a',
    surfaceSessionId: 'runtime:a:1',
    occluded: false,
  };
  const bVisible = {
    ownerSessionId: 'runtime:b',
    surfaceSessionId: 'runtime:b:2',
    occluded: false,
  };
  const bOccluded = { ...bVisible, occluded: true };

  const firstARevision = allocator.observe(aVisible);
  assert.equal(allocator.observe(aVisible), firstARevision);
  const switchToBRevision = allocator.observe(bVisible);
  assert.equal(switchToBRevision, firstARevision + 1);
  const switchBackToARevision = allocator.observe(aVisible);
  assert.equal(switchBackToARevision, switchToBRevision + 1);
  assert.equal(allocator.observe(bOccluded), switchBackToARevision + 1);
  assert.equal(allocator.observe(bOccluded), switchBackToARevision + 1);
});

test('Workspace propagates one epoch to every Mode 2 panel and sync captures it', async () => {
  const [workspace, panel, ipc] = await Promise.all([
    readRepoText('src', 'pages', 'Workspace.tsx'),
    readRepoText('src', 'components', 'workspace', 'BrowserPanel.tsx'),
    readRepoText('src', 'lib', 'browserSurfaceIpc.ts'),
  ]);

  assert.match(workspace, /browserPresentationRevisionAllocatorRef\.current\.observe\(\{/);
  assert.match(workspace, /presentationRevision: browserPresentationRevision,/);
  assert.doesNotMatch(workspace, /backend:\s*activeVisibleBrowserTarget/);
  assert.match(
    panel,
    /requestedPresentationRevision: number,[\s\S]*presentationRevision: requestedPresentationRevision/,
  );
  assert.match(panel, /syncSurface\(requestedVisible, presentationRevision\)/);
  assert.match(
    panel,
    /lifecycleActionsRef\.current\.syncSurface\(\s*true,\s*presentationRevisionRef\.current,/,
  );
  assert.match(ipc, /presentationRevision: number;/);
});

test('Mode 2 acquire lifetime stays stable across active, occlusion, and presentation updates', async () => {
  const panel = await readRepoText('src', 'components', 'workspace', 'BrowserPanel.tsx');
  const acquireStart = panel.indexOf('  useEffect(() => {\n    let disposed = false;');
  const nextEffect = panel.indexOf('\n\n  useEffect(() => {\n    if (!isSurfaceReady) return;', acquireStart);
  assert.notEqual(acquireStart, -1, 'Mode 2 acquire effect should exist');
  assert.notEqual(nextEffect, -1, 'Mode 2 acquire effect should have a bounded lifetime');

  const acquireEffect = panel.slice(acquireStart, nextEffect);
  const dependencyStart = acquireEffect.lastIndexOf('  }, [');
  assert.notEqual(dependencyStart, -1, 'Mode 2 acquire effect should have explicit dependencies');
  const dependencyList = acquireEffect.slice(dependencyStart);
  assert.doesNotMatch(
    dependencyList,
    /presentationRevision|isActiveSurface|surfaceOccluded|applySurfaceSnapshot|readViewport|syncSurface|\bt\b/,
  );
  assert.match(
    dependencyList,
    /\[loginProfileId, profileMode, sessionId, showLifecycleError, surfaceOrdering, workingDir\]/,
  );
  assert.match(
    acquireEffect,
    /lifecycleActionsRef\.current\.syncSurface\(\s*true,\s*presentationRevisionRef\.current,/,
  );
});
