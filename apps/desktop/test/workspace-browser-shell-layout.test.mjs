import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

test('workspace browser renders as a sidebar sibling of the workspace column', async () => {
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
  assert.match(workspaceSource, /browserPanelSessionKeyRegistryRef = useRef\(createBrowserPanelSessionKeyRegistry\(\)\)/);
  assert.match(workspaceSource, /const activeBrowserSessionId = useMemo/);
  assert.match(workspaceSource, /workspaceMode === 'live' && activeLiveEntry[\s\S]*browserPanelSessionKeyRegistryRef\.current\.resolveLive/);
  assert.match(workspaceSource, /workspaceMode === 'history' && selectedSession[\s\S]*matchingLiveEntry[\s\S]*resolveHistory/);
  assert.match(workspaceSource, /const activeBrowserTarget = browserTargetBySessionId\[activeBrowserSessionId\] \?\? null/);
  assert.match(workspaceSource, /const activeVisibleBrowserTarget = isBrowserPanelTargetVisible\(activeBrowserTarget\)/);
  assert.match(workspaceSource, /const browserPanelOpen = activeVisibleBrowserTarget !== null/);
  assert.match(workspaceSource, /browser_set_active_session/);
  assert.match(
    workspaceSource,
    /browser_panel_requested[\s\S]*cause !== 'agent_reveal'[\s\S]*return/,
  );
  assert.match(workspaceSource, /<WorkspaceStatusStrip[\s\S]*browserOpen=\{browserPanelOpen\}[\s\S]*browserBackend=\{activeVisibleBrowserTarget\?\.backend \?\? null\}[\s\S]*onTogglePreviewBrowser=\{toggleActivePreviewBrowser\}[\s\S]*onOpenLoginBrowser=\{openActiveLoginBrowser\}/);
  assert.match(
    workspaceSource,
    /className="workspace-main-container flex min-h-0 min-w-0 flex-1 overflow-hidden"/,
  );
  assert.doesNotMatch(workspaceSource, /data-ccem-workspace-browser-left/);
  assert.doesNotMatch(
    workspaceSource,
    /className="workspace-main-container mx-3 mb-3 flex min-h-0 flex-1 overflow-hidden"/,
  );
  assert.doesNotMatch(
    workspaceSource,
    /data-ccem-workspace-browser-layout=[\s\S]{0,180}className="mx-3 mb-3 flex/,
  );
  assert.doesNotMatch(workspaceSource, /renderBrowserAction/);
  assert.doesNotMatch(workspaceSource, /browserAction=\{/);

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
    workspaceSource.slice(siblingBrowserTargetMapIndex, browserPanelIndex + 1200),
    /const panelKey = String\(target\.instanceId\);[\s\S]*sessionId: target\.surfaceSessionId,[\s\S]*isActiveSurface: isPanelActive,[\s\S]*surfaceOccluded: browserSurfaceOccluded \|\| !isPanelActive,[\s\S]*className: 'h-full w-full',[\s\S]*onResizeStart: handleBrowserPanelResizeStart[\s\S]*key=\{panelKey\}[\s\S]*isPanelActive \? 'flex' : 'hidden'/,
  );
  assert.doesNotMatch(workspaceSource, /key=\{`\$\{sessionId\}:\$\{target\.requestId\}`\}/);
});

test('workspace browser entry lives beside the review action in the status strip', async () => {
  const statusStripSource = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceStatusStrip.tsx'),
    'utf8',
  );
  const launcherSource = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserLauncherPopover.tsx'),
    'utf8',
  );

  assert.match(statusStripSource, /BrowserLauncherPopover/);
  assert.match(statusStripSource, /browserOpen\?: boolean/);
  assert.match(statusStripSource, /browserBackend\?: BrowserSurfaceBackend \| null/);
  assert.match(statusStripSource, /onTogglePreviewBrowser\?: \(\) => void/);
  assert.match(statusStripSource, /onOpenLoginBrowser\?: \(request: LoginBrowserPanelRequest\) => void/);
  assert.match(
    statusStripSource,
    /data-ccem-workspace-status-compact=\{browserOpen \? 'browser' : 'default'\}/,
  );
  assert.match(statusStripSource, /compact=\{browserOpen\}/);
  assert.match(statusStripSource, /whitespace-nowrap/);
  assert.match(statusStripSource, /continuousUsageDays > 0 && usageStats/);
  assert.match(statusStripSource, /browserOpen \? 'inline-flex' : 'hidden md:inline-flex'/);
  assert.match(statusStripSource, /!browserOpen && activeCronTasks\.length > 0/);
  assert.match(statusStripSource, /data-ccem-workspace-search-trigger="true"/);
  assert.match(launcherSource, /data-ccem-workspace-browser-toggle="true"/);
  assert.match(launcherSource, /PanelRightOpen/);
  assert.match(launcherSource, /PanelRightClose/);
  assert.match(launcherSource, /title=\{t\('workspace.browserHub'\)\}/);
  assert.match(launcherSource, /aria-label=\{t\('workspace.browserHub'\)\}/);
  assert.match(launcherSource, /onTogglePreview/);
  assert.match(launcherSource, /onOpenLoginBrowser/);
  assert.match(launcherSource, /panelOpen \? \(/);
  assert.match(launcherSource, /previewOpen \? t\('workspace\.browserHide'\)/);
  assert.match(launcherSource, /h-8 w-8 min-h-\[2rem\] min-w-\[2rem\] flex-none/);
  assert.match(statusStripSource, /browserOpen \? 'sr-only' : 'sm:text-\[13px\]'/);

  const reviewIndex = statusStripSource.indexOf("title={t('workspace.reviewEntry')}");
  const browserIndex = statusStripSource.indexOf('<BrowserLauncherPopover');
  assert.ok(reviewIndex > 0);
  assert.ok(browserIndex > reviewIndex);
});

test('browser panel uses standalone sidebar chrome with tab and lower navigation', async () => {
  const [browserPanelSource, browserPanelChromeSource, previewMutationSource, cssSource] = await Promise.all([
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanel.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserPanelChrome.tsx'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'hooks', 'usePreviewSurfaceMutation.ts'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src', 'index.css'),
      'utf8',
    ),
  ]);

  assert.match(browserPanelSource, /data-ccem-browser-panel="true"/);
  assert.match(browserPanelSource, /sessionId: string/);
  assert.match(browserPanelSource, /backend: 'preview'/);
  assert.match(browserPanelSource, /backend: 'login'/);
  assert.match(browserPanelSource, /data-ccem-browser-resize-handle="true"/);
  assert.match(browserPanelSource, /data-ccem-browser-tab-strip="true"/);
  assert.match(browserPanelSource, /<BrowserPanelNavigation/);
  assert.match(browserPanelChromeSource, /data-ccem-browser-navigation="true"/);
  assert.match(browserPanelSource, /workspace-browser-panel relative flex h-full/);
  assert.match(browserPanelChromeSource, /data-ccem-browser-url-display="true"/);
  assert.match(browserPanelChromeSource, /data-ccem-browser-url-input="true"/);
  assert.match(browserPanelSource, /onSubmit=\{handleSubmit\}/);
  assert.match(browserPanelSource, /browser_navigate[\s\S]*\{ sessionId, url: nextUrl \}/);
  assert.match(browserPanelSource, /invoke<BrowserInfo>\(command, \{ sessionId \}\)/);
  assert.match(browserPanelChromeSource, /disabled=\{backend === 'login' \|\| isBusy \|\| !canGoBack\}/);
  assert.match(browserPanelChromeSource, /disabled=\{backend === 'login' \|\| isBusy \|\| !canGoForward\}/);
  assert.match(browserPanelSource, /browser_set_bounds[\s\S]*\{ sessionId, \.\.\.bounds \}/);
  assert.match(browserPanelSource, /usePreviewSurfaceMutation/);
  assert.match(
    previewMutationSource,
    /browser_set_visible[\s\S]*sessionId,[\s\S]*visible: false,[\s\S]*presentationRevision: retirementPresentationRevision/,
  );
  assert.match(browserPanelSource, /listen<BrowserSessionStateEvent>\('browser_session_state_changed'/);
  assert.match(browserPanelSource, /browser_health_check/);
  assert.match(browserPanelSource, /browser_set_paused/);
  assert.match(browserPanelSource, /browserSurfaceClient\.acquire/);
  assert.match(browserPanelSource, /browser_surface_state_changed/);
  assert.match(browserPanelSource, /browserSurfaceClient\.release/);
  assert.match(browserPanelSource, /browserAgentControlling/);
  assert.match(
    browserPanelSource,
    /localhost\|127[\s\S]*return `http:\/\/\$\{trimmed\}`/,
  );
  assert.doesNotMatch(browserPanelSource, /border-l border-border/);

  const tabStripIndex = browserPanelSource.indexOf('<BrowserPanelTabStrip');
  const navigationIndex = browserPanelSource.indexOf('<BrowserPanelNavigation');
  assert.ok(tabStripIndex > 0);
  assert.ok(navigationIndex > tabStripIndex);
  assert.doesNotMatch(browserPanelSource.slice(tabStripIndex, navigationIndex), /<Input/);
  assert.match(
    browserPanelChromeSource,
    /export function BrowserPanelNavigation[\s\S]*data-ccem-browser-navigation="true"[\s\S]*<Input/,
  );

  const browserPanelCss = cssSource.match(/\.workspace-browser-panel \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(browserPanelCss, /border-left:/);
  assert.doesNotMatch(browserPanelCss, /border-radius:/);
});
