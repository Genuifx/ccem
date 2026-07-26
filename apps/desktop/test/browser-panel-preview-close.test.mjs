import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

test('preview X closes its exact native surface before removing the mounted panel', async () => {
  const panel = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
    'utf8',
  );
  const closeStart = panel.indexOf('const handleClose = useCallback(async () => {');
  const closeEnd = panel.indexOf('\n\n  const cancelUrlEditing', closeStart);
  const closeSource = panel.slice(closeStart, closeEnd);

  assert.ok(closeStart >= 0);
  assert.match(
    closeSource,
    /if \(backend === 'preview'\) \{[\s\S]*previewCloseRequestedRef\.current = true;[\s\S]*runPreviewSurfaceMutation\(\(\) => \([\s\S]*invoke\('browser_close', \{ sessionId \}\)[\s\S]*\)\);/,
  );
  assert.ok(
    closeSource.indexOf("invoke('browser_close', { sessionId })")
      < closeSource.indexOf('onClose();'),
    'remove the React target only after the exact preview close succeeds',
  );
  assert.match(closeSource, /previewCloseRequestedRef\.current = false;[\s\S]*setIsClosingSurface\(false\)/);
});

test('status-toggle retains a preview instance and only changes its visible intent', async () => {
  const [panel, mutationHook, workspace] = await Promise.all([
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'hooks', 'usePreviewSurfaceMutation.ts'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'), 'utf8'),
  ]);

  assert.equal((panel.match(/browser_close/g) ?? []).length, 1);
  assert.match(
    mutationHook,
    /invoke\('browser_set_visible', \{[\s\S]*sessionId,[\s\S]*visible: false,[\s\S]*presentationRevision: retirementPresentationRevision/,
  );
  assert.doesNotMatch(mutationHook, /browser_close/);
  assert.doesNotMatch(panel, /closeRequestId/);

  const toggleStart = workspace.indexOf('const toggleActivePreviewBrowser = useCallback');
  const toggleEnd = workspace.indexOf('\n\n  const openActiveLoginBrowser', toggleStart);
  const toggleSource = workspace.slice(toggleStart, toggleEnd);
  assert.match(
    toggleSource,
    /existing\?\.backend === 'preview'[\s\S]*setPreviewBrowserPanelAgentSessionId\([\s\S]*setBrowserPanelTargetVisible\(\s*withAgentSession,\s*!isBrowserPanelTargetVisible\(existing\),\s*\)/,
  );
  assert.doesNotMatch(toggleSource, /delete next\[activeBrowserSessionId\]/);
  assert.doesNotMatch(toggleSource, /browser_close/);
});
