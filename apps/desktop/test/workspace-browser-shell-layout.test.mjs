import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

test('workspace browser renders as a retained sidebar sibling of the workspace column', async () => {
  const workspaceSource = await fs.readFile(
    path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'),
    'utf8',
  );

  assert.match(
    workspaceSource,
    /data-ccem-workspace-browser-layout=\{browserPanelOpen \? 'shell-browser-split' : 'workspace'\}/,
  );
  assert.match(workspaceSource, /ref=\{browserLayoutRef\}/);
  assert.match(workspaceSource, /data-ccem-workspace-column="true"/);
  assert.match(workspaceSource, /data-ccem-workspace-shell="true"/);
  assert.match(workspaceSource, /browserTargetBySessionId/);
  assert.match(workspaceSource, /const activeBrowserSessionId = useMemo/);
  assert.match(workspaceSource, /const activeBrowserTarget = browserTargetBySessionId\[activeBrowserSessionId\] \?\? null/);
  assert.match(workspaceSource, /const activeVisibleBrowserTarget = isBrowserPanelTargetVisible\(activeBrowserTarget\)/);
  assert.match(workspaceSource, /const browserPanelOpen = activeVisibleBrowserTarget !== null/);
  assert.match(
    workspaceSource,
    /<WorkspaceStatusStrip[\s\S]*browserOpen=\{browserPanelOpen\}[\s\S]*onToggleBrowser=\{\(\) => toggleActiveBrowser\(skillsContext\.workingDir\)\}/,
  );
  assert.match(
    workspaceSource,
    /className="workspace-main-container flex min-h-0 min-w-0 flex-1 overflow-hidden"/,
  );
  assert.doesNotMatch(workspaceSource, /browser_panel_requested|browser_set_active_session/);

  const layoutIndex = workspaceSource.indexOf('data-ccem-workspace-browser-layout');
  const columnIndex = workspaceSource.indexOf('data-ccem-workspace-column="true"', layoutIndex);
  const statusStripIndex = workspaceSource.indexOf('<WorkspaceStatusStrip', columnIndex);
  const shellIndex = workspaceSource.indexOf('data-ccem-workspace-shell="true"', columnIndex);
  const siblingBrowserTargetMapIndex = workspaceSource.indexOf(
    '\n        {Object.entries(browserTargetBySessionId).map',
    columnIndex,
  );
  const browserPanelIndex = workspaceSource.indexOf('<BrowserPanel', siblingBrowserTargetMapIndex);

  assert.ok(columnIndex > layoutIndex);
  assert.ok(statusStripIndex > columnIndex);
  assert.ok(shellIndex > statusStripIndex);
  assert.ok(siblingBrowserTargetMapIndex > shellIndex);
  assert.ok(browserPanelIndex > siblingBrowserTargetMapIndex);
  assert.match(
    workspaceSource.slice(siblingBrowserTargetMapIndex, browserPanelIndex + 900),
    /const panelKey = String\(target\.instanceId\);[\s\S]*sessionId: target\.surfaceSessionId,[\s\S]*isActiveSurface: isPanelActive,[\s\S]*surfaceOccluded: browserSurfaceOccluded \|\| !isPanelActive,[\s\S]*key=\{panelKey\}[\s\S]*isPanelActive \? 'flex' : 'hidden'/,
  );
});

test('status-strip browser entry is one direct open-hide toggle and preserves the Route chip', async () => {
  const statusStripSource = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceStatusStrip.tsx'),
    'utf8',
  );

  assert.match(statusStripSource, /import \{ WorkspaceRouteChip \} from '\.\/WorkspaceRouter'/);
  assert.match(statusStripSource, /<WorkspaceRouteChip/);
  assert.match(statusStripSource, /browserOpen\?: boolean/);
  assert.match(statusStripSource, /onToggleBrowser\?: \(\) => void/);
  assert.match(statusStripSource, /data-ccem-workspace-browser-toggle="true"/);
  assert.match(statusStripSource, /onClick=\{onToggleBrowser\}/);
  assert.match(statusStripSource, /browserOpen \? 'workspace\.browserClose' : 'workspace\.browserOpen'/);
  assert.match(statusStripSource, /PanelRightOpen/);
  assert.match(statusStripSource, /PanelRightClose/);
  assert.doesNotMatch(
    statusStripSource,
    /BrowserLauncherPopover|browserBackend|onTogglePreviewBrowser|onOpenLoginBrowser/,
  );

  const reviewIndex = statusStripSource.indexOf("title={t('workspace.reviewEntry')}");
  const browserIndex = statusStripSource.indexOf('data-ccem-workspace-browser-toggle="true"');
  assert.ok(reviewIndex > 0);
  assert.ok(browserIndex > reviewIndex);
});

test('browser panel exposes only Mode 2 sidebar chrome and native surface IPC', async () => {
  const [browserPanelSource, browserPanelChromeSource, cssSource] = await Promise.all([
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanelChrome.tsx'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src', 'index.css'), 'utf8'),
  ]);

  assert.match(browserPanelSource, /data-ccem-browser-panel="true"/);
  assert.match(browserPanelSource, /data-ccem-browser-backend="login"/);
  assert.match(browserPanelSource, /backend: 'login'/);
  assert.match(browserPanelSource, /data-ccem-browser-resize-handle="true"/);
  assert.match(browserPanelSource, /data-ccem-browser-tab-strip="true"/);
  assert.match(browserPanelSource, /<BrowserPanelNavigation/);
  assert.match(browserPanelChromeSource, /data-ccem-browser-navigation="true"/);
  assert.match(browserPanelChromeSource, /data-ccem-browser-url-display="true"/);
  assert.match(browserPanelChromeSource, /data-ccem-browser-url-input="true"/);
  assert.match(browserPanelSource, /browserSurfaceClient\.acquire/);
  assert.match(browserPanelSource, /browser_surface_state_changed/);
  assert.match(browserPanelSource, /browserSurfaceClient\.navigate/);
  assert.match(browserPanelSource, /browserSurfaceClient\.release/);
  assert.match(browserPanelSource, /occlude: occludeSurface/);
  assert.match(browserPanelSource, /browserAgentControlling/);
  assert.doesNotMatch(
    `${browserPanelSource}\n${browserPanelChromeSource}`,
    /backend:\s*'preview'|backend === 'preview'|browser_open|browser_set_visible|usePreviewSurfaceMutation/i,
  );

  const tabStripIndex = browserPanelSource.indexOf('<BrowserPanelTabStrip');
  const navigationIndex = browserPanelSource.indexOf('<BrowserPanelNavigation');
  assert.ok(tabStripIndex > 0);
  assert.ok(navigationIndex > tabStripIndex);

  const browserPanelCss = cssSource.match(/\.workspace-browser-panel \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(browserPanelCss, /border-left:/);
  assert.doesNotMatch(browserPanelCss, /border-radius:/);
});
