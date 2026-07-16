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

async function importPreviewSurfaceOrdering() {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'lib', 'previewSurfaceOrdering.ts'),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-preview-ordering-'));
  const outputPath = path.join(tempDir, 'previewSurfaceOrdering.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('replacement B cannot be affected by deferred A completion or cleanup', async () => {
  const { createPreviewSurfaceOrdering, previewPanelScope } = await importPreviewSurfaceOrdering();
  const ordering = createPreviewSurfaceOrdering();
  const gate = deferred();
  const events = [];
  const scope = previewPanelScope('same-session');
  const ownerA = ordering.claim(scope);
  const openA = ordering.enqueue(ownerA, async () => {
    events.push('A:open:start');
    await gate.promise;
    events.push('A:open:backend-finished');
    return 'A';
  });
  await Promise.resolve();

  const cleanupA = ordering.enqueue(ownerA, async () => {
    events.push('A:hide');
  });
  const boundsA = ordering.enqueue(ownerA, async () => {
    events.push('A:bounds');
  });
  const ownerB = ordering.claim(scope);
  const revealB = ordering.enqueue(ownerB, async () => {
    events.push('B:reveal');
    return 'B';
  });
  gate.resolve();

  assert.deepEqual(await openA, { applied: false });
  assert.deepEqual(await cleanupA, { applied: false });
  assert.deepEqual(await boundsA, { applied: false });
  assert.deepEqual(await revealB, { applied: true, value: 'B' });
  assert.deepEqual(events, ['A:open:start', 'A:open:backend-finished', 'B:reveal']);

  const lateCleanupA = await ordering.enqueue(ownerA, async () => {
    events.push('A:late-hide');
  });
  assert.deepEqual(lateCleanupA, { applied: false });
  assert.equal(events.includes('A:late-hide'), false);
});

test('Workspace stale visible=false completes before the latest visible=true', async () => {
  const { createPreviewSurfaceOrdering, PREVIEW_ACTIVE_SESSION_SCOPE } = await importPreviewSurfaceOrdering();
  const ordering = createPreviewSurfaceOrdering();
  const gate = deferred();
  const events = [];
  let visible = true;
  const closingOwner = ordering.claim(PREVIEW_ACTIVE_SESSION_SCOPE);
  const staleHide = ordering.enqueue(closingOwner, async () => {
    events.push('hide:start');
    await gate.promise;
    visible = false;
    events.push('hide:finish');
  });
  await Promise.resolve();

  const reopenedOwner = ordering.claim(PREVIEW_ACTIVE_SESSION_SCOPE);
  const latestReveal = ordering.enqueue(reopenedOwner, async () => {
    visible = true;
    events.push('reveal');
  });
  gate.resolve();

  assert.deepEqual(await staleHide, { applied: false });
  assert.deepEqual(await latestReveal, { applied: true, value: undefined });
  assert.deepEqual(events, ['hide:start', 'hide:finish', 'reveal']);
  assert.equal(visible, true);
});

test('Preview integration routes lifecycle mutations and active-session visibility through the shared lane', async () => {
  const [panel, hook, workspace] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'hooks', 'usePreviewSurfaceMutation.ts'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'), 'utf8'),
  ]);

  assert.match(panel, /usePreviewSurfaceMutation\(backend === 'preview' \? sessionId : null\)/);
  assert.doesNotMatch(panel, /previewVisibilityTailRef/);
  assert.match(panel, /runPreviewSurfaceMutation\(\(\) => invoke<BrowserInfo>\('browser_open'/);
  assert.match(panel, /runPreviewSurfaceMutation\(async \(\) => \{[\s\S]*?'browser_set_visible'/);
  assert.match(panel, /runPreviewSurfaceMutation\(\(\) => invoke\('browser_set_bounds'/);
  assert.match(hook, /useLayoutEffect/);
  assert.match(hook, /previewSurfaceOrdering\.claim\(previewPanelScope\(sessionId\)\)/);
  assert.match(hook, /invoke\('browser_set_visible', \{ sessionId, visible: false \}\)/);
  assert.match(workspace, /previewSurfaceOrdering\.claim\(PREVIEW_ACTIVE_SESSION_SCOPE\)/);
  assert.match(workspace, /previewSurfaceOrdering\.enqueue\(owner, \(\) => invoke\('browser_set_active_session'/);
});
