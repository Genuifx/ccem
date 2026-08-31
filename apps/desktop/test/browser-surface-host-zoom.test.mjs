import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CEF host zoom actions reuse the single useZoom state lane', async () => {
  const [ipcSource, workspaceSource, zoomSource] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src', 'lib', 'browserSurfaceIpc.ts'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'hooks', 'useZoom.ts'), 'utf8'),
  ]);

  for (const action of ['zoom_in', 'zoom_out', 'zoom_reset']) {
    assert.match(ipcSource, new RegExp(`\\| '${action}'`));
  }
  assert.match(
    workspaceSource,
    /case 'zoom_in':\s*case 'zoom_out':\s*case 'zoom_reset':\s*dispatchAppZoomCommand\(action\)/,
  );

  assert.match(zoomSource, /export function dispatchAppZoomCommand\(command: AppZoomCommand\)/);
  assert.match(zoomSource, /if \(!isAppZoomCommand\(command\)\) return;/);
  assert.match(zoomSource, /const applyZoomCommand = \(command: AppZoomCommand\) =>/);
  assert.match(zoomSource, /applyZoomCommand\('zoom_in'\)/);
  assert.match(zoomSource, /applyZoomCommand\('zoom_out'\)/);
  assert.match(zoomSource, /applyZoomCommand\('zoom_reset'\)/);
  assert.match(zoomSource, /applyZoomCommand\(command\)/);
  assert.match(
    zoomSource,
    /window\.addEventListener\(CCEM_ZOOM_COMMAND_EVENT, handleZoomCommandEvent\)/,
  );
  assert.equal(
    zoomSource.match(/let current = initial;/g)?.length,
    1,
    'keyboard and CEF commands must share one current zoom value',
  );
  assert.doesNotMatch(workspaceSource, /CCEM_ZOOM_STORAGE_KEY|setZoom\(/);
});
