import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const sourceDir = path.join(desktopDir, 'src');
const tauriSrcDir = path.join(desktopDir, 'src-tauri', 'src');

test('tray cockpit owns left-click while preserving the native context menu', async () => {
  const [
    traySource,
    mainSource,
    entrySource,
    appSource,
    capabilitySource,
    cssSource,
    cockpitSource,
    analyticsSource,
    zhLocaleSource,
    enLocaleSource,
    packageSource,
  ] =
    await Promise.all([
      fs.readFile(path.join(tauriSrcDir, 'tray.rs'), 'utf8'),
      fs.readFile(path.join(tauriSrcDir, 'lib.rs'), 'utf8'),
      fs.readFile(path.join(sourceDir, 'main.tsx'), 'utf8'),
      fs.readFile(path.join(sourceDir, 'App.tsx'), 'utf8'),
      fs.readFile(path.join(desktopDir, 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
      fs.readFile(path.join(sourceDir, 'index.css'), 'utf8'),
      fs.readFile(path.join(sourceDir, 'pages', 'TrayCockpit.tsx'), 'utf8'),
      fs.readFile(path.join(tauriSrcDir, 'analytics.rs'), 'utf8'),
      fs.readFile(path.join(sourceDir, 'locales', 'zh.json'), 'utf8'),
      fs.readFile(path.join(sourceDir, 'locales', 'en.json'), 'utf8'),
      fs.readFile(path.join(desktopDir, 'package.json'), 'utf8'),
    ]);

  const capabilities = JSON.parse(capabilitySource);
  const packageJson = JSON.parse(packageSource);
  const trayPanelCss = cssSource.match(/\.tray-cockpit-panel \{[\s\S]*?\n\}/)?.[0];
  assert.ok(trayPanelCss, 'tray cockpit panel CSS block should exist');

  assert.match(traySource, /pub const TRAY_COCKPIT_LABEL: &str = "tray-cockpit"/);
  assert.match(traySource, /\.show_menu_on_left_click\(false\)/);
  assert.match(
    traySource,
    /on_tray_icon_event[\s\S]*MouseButton::Left[\s\S]*MouseButtonState::Up[\s\S]*rect[\s\S]*TrayCockpitAnchor::icon_rect[\s\S]*toggle_tray_cockpit/,
  );
  assert.match(traySource, /WebviewWindowBuilder::new[\s\S]*TRAY_COCKPIT_LABEL[\s\S]*index\.html\?window=tray-cockpit/);
  assert.match(traySource, /const TRAY_COCKPIT_PANEL_WIDTH: f64 = 390\.0/);
  assert.match(traySource, /const TRAY_COCKPIT_PANEL_HEIGHT: f64 = 700\.0/);
  assert.match(traySource, /const TRAY_COCKPIT_SHADOW_MARGIN_X: f64 = 32\.0/);
  assert.match(traySource, /const TRAY_COCKPIT_SHADOW_MARGIN_TOP: f64 = 8\.0/);
  assert.match(traySource, /const TRAY_COCKPIT_SHADOW_MARGIN_BOTTOM: f64 = 48\.0/);
  assert.match(traySource, /const TRAY_COCKPIT_WIDTH: f64 = TRAY_COCKPIT_PANEL_WIDTH \+ TRAY_COCKPIT_SHADOW_MARGIN_X \* 2\.0/);
  assert.match(traySource, /inner_size\(TRAY_COCKPIT_WIDTH, TRAY_COCKPIT_HEIGHT\)/);
  assert.match(traySource, /panel_x - TRAY_COCKPIT_SHADOW_MARGIN_X/);
  assert.match(traySource, /panel_y - TRAY_COCKPIT_SHADOW_MARGIN_TOP/);
  assert.match(traySource, /#\[tauri::command\][\s\S]*pub fn open_tray_cockpit/);
  assert.match(traySource, /pub async fn get_tray_runtime_snapshot/);
  assert.match(traySource, /fn schedule_tray_cockpit_build/);
  assert.match(traySource, /tauri::async_runtime::spawn_blocking/);
  // Plan 024: the startup prewarm is gone — the cockpit webview builds lazily
  // on first open via schedule_tray_cockpit_build.
  assert.doesNotMatch(traySource, /pub fn prepare_tray_cockpit/);

  assert.match(mainSource, /use tray::\{create_tray, TRAY_COCKPIT_LABEL\}/);
  assert.match(mainSource, /tray::open_tray_cockpit/);
  assert.match(mainSource, /tray::get_tray_runtime_snapshot/);
  assert.match(mainSource, /analytics::get_tray_usage_stats/);
  assert.doesNotMatch(mainSource, /tray::prepare_tray_cockpit/);
  const trayUsageCommand = analyticsSource.match(
    /pub async fn get_tray_usage_stats\(\)[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(trayUsageCommand, 'lightweight tray usage command should exist');
  assert.match(trayUsageCommand, /read_tray_usage_stats/);
  assert.doesNotMatch(trayUsageCommand, /refresh_usage_cache/);
  assert.match(mainSource, /window\.label\(\) == TRAY_COCKPIT_LABEL[\s\S]*api\.prevent_close\(\)[\s\S]*hide_tray_cockpit/);
  assert.match(entrySource, /resolveDesktopWindowRoot\(requestedWindow, nativeWindowLabel\)/);
  assert.match(entrySource, /case 'tray-cockpit':[\s\S]*return TrayCockpit/);
  assert.match(appSource, /listen<TrayOpenTabRequest>\('tray-open-tab'[\s\S]*navigateToTab\(event\.payload\.tab\)/);
  assert.deepEqual(capabilities.webviews, ['main', 'desktop-pet', 'tray-cockpit']);
  for (const permission of [
    'core:window:allow-hide',
    'core:window:allow-set-focus',
    'core:window:allow-show',
    'core:window:allow-unminimize',
  ]) {
    assert.ok(capabilities.permissions.includes(permission), `${permission} is required for tray dock actions`);
  }

  assert.match(cssSource, /html\[data-window='tray-cockpit'\]/);
  assert.match(cssSource, /prefers-reduced-motion/);
  assert.match(cssSource, /data-performance-mode='reduced'\] \.tray-cockpit-window/);
  assert.match(cssSource, /tray-logo-image/);
  assert.match(cssSource, /tray-chart-hitbox/);
  assert.match(cssSource, /tray-chart-tooltip/);
  assert.match(cssSource, /tray-chart-cursor/);
  assert.match(cssSource, /tray-chart-range-button/);
  assert.match(cssSource, /stroke-dashoffset: 1/);
  assert.match(cssSource, /--tray-bg: #141416/);
  assert.match(cssSource, /html\.light\[data-window='tray-cockpit'\][\s\S]*--tray-bg: #f6f8fb/);
  assert.match(trayPanelCss, /background-color: var\(--tray-bg\)/);
  assert.doesNotMatch(trayPanelCss, /backdrop-filter/);
  assert.doesNotMatch(cssSource, /--tray-bg: rgba/);
  assert.match(cssSource, /--tray-divider: rgba\(255, 255, 255, 0\.06\)/);
  assert.match(cssSource, /--tray-accent-soft: hsl\(var\(--primary\) \/ 0\.16\)/);
  assert.match(cssSource, /--tray-accent-softer: hsl\(var\(--primary\) \/ 0\.08\)/);
  assert.match(cssSource, /--tray-bg-solid: #141416/);
  assert.match(cssSource, /\.tray-dock-button:hover/);
  assert.match(cssSource, /\.tray-icon-button:hover/);
  assert.match(cockpitSource, /px-\[32px\] pb-\[48px\] pt-2/);
  assert.match(cockpitSource, /before:bg-\[var\(--tray-divider\)\]/);
  assert.match(cockpitSource, /bg-\[var\(--tray-accent-softer\)\]/);
  assert.match(cockpitSource, /bg-\[var\(--tray-bg-solid\)\]/);
  assert.match(cockpitSource, /rounded-\[10px\]/);
  assert.match(cockpitSource, /rounded-\[14px\]/);
  // HealthRow four-cell status grid is intentionally removed; ensure it does not creep back.
  assert.doesNotMatch(cockpitSource, /function HealthRow/);
  assert.doesNotMatch(cockpitSource, /<HealthRow/);
  assert.doesNotMatch(cockpitSource, /healthItems/);
  assert.equal(packageJson.dependencies.gsap, '^3.15.0');
  assert.equal(packageJson.dependencies['@gsap/react'], '^2.1.2');
  assert.match(cockpitSource, /import \{ gsap \} from 'gsap'/);
  assert.match(cockpitSource, /import \{ useGSAP \} from '@gsap\/react'/);
  assert.match(cockpitSource, /gsap\.registerPlugin\(useGSAP\)/);
  assert.match(cockpitSource, /gsap\.timeline/);
  assert.match(cockpitSource, /gsap\.quickTo/);
  assert.match(cockpitSource, /chartPoints/);
  assert.match(cockpitSource, /type TrayChartRange = 'hour' \| 'day'/);
  assert.match(cockpitSource, /useState<TrayChartRange>\('hour'\)/);
  assert.match(cockpitSource, /buildChartSeries\(snapshot\.usage, chartRange, lang\)/);
  assert.match(cockpitSource, /usage\.hourlyHistory/);
  assert.match(cockpitSource, /usage\.dailyHistory/);
  assert.match(cockpitSource, /snapshot\.usage\.byModel/);
  assert.match(cockpitSource, /onPointerMove=\{moveHover\}/);
  assert.match(cockpitSource, /tray-chart-hitbox/);
  assert.match(cockpitSource, /tray-chart-tooltip/);
  assert.match(cockpitSource, /tray-chart-cursor/);
  assert.match(cockpitSource, /tray-chart-range-button/);
  assert.match(cockpitSource, /function StatStrip/);
  assert.match(cockpitSource, /function ActivityChart/);
  assert.match(cockpitSource, /function ModelTypeSplit/);
  assert.match(cockpitSource, /function modelTypeBreakdown/);
  assert.match(cockpitSource, /modelTypeLabel/);
  assert.match(cockpitSource, /function TrayLogo/);
  assert.match(cockpitSource, /previewTheme === 'dark' \|\| previewTheme === 'light'/);
  assert.match(cockpitSource, /src="\/logo_preview\.png"/);
  assert.match(cockpitSource, /alt="CCEM"/);
  assert.doesNotMatch(cockpitSource, /<svg className="tray-logo-mark/);
  assert.match(cockpitSource, /tray-logo-ring/);
  assert.match(cockpitSource, /tray-chart-line/);
  assert.match(cockpitSource, /tray-model-bar/);
  assert.match(cockpitSource, /tray-dock-button/);
  assert.doesNotMatch(cockpitSource, /function ProviderSplit/);
  assert.doesNotMatch(cockpitSource, /providerBreakdown/);
  assert.doesNotMatch(cockpitSource, /tray-provider-bar/);
  assert.match(cockpitSource, /createTrayRefreshGate/);
  assert.match(cockpitSource, /invoke<UsageStats \| null>\('get_tray_usage_stats'\)/);
  assert.match(cockpitSource, /invoke<TrayRuntimeSnapshot>\('get_tray_runtime_snapshot'\)/);
  assert.match(cockpitSource, /invoke<UsageStats>\('get_usage_stats', \{ force: true \}\)/);
  assert.doesNotMatch(cockpitSource, /window\.setInterval/);
  assert.doesNotMatch(cockpitSource, /REFRESH_INTERVAL_MS/);
  assert.doesNotMatch(cockpitSource, /invoke<CronTask\[]>\('list_cron_tasks'\)/);
  assert.doesNotMatch(cockpitSource, /get_platform_capabilities/);
  assert.doesNotMatch(cockpitSource, /get_telegram_bridge_status/);
  assert.doesNotMatch(cockpitSource, /get_app_version/);
  assert.doesNotMatch(cockpitSource, /trayCockpit\.(live|preview)/);
  assert.doesNotMatch(cockpitSource, /snapshot\.source/);
  assert.doesNotMatch(zhLocaleSource, /实时驾驶舱|预览数据/);
  assert.doesNotMatch(enLocaleSource, /Live cockpit|Preview data/);
  assert.match(cockpitSource, /dataset\.performanceMode === 'reduced'/);
  assert.match(cockpitSource, /WebviewWindow\.getByLabel\('main'\)/);
  assert.match(cockpitSource, /emit\('tray-open-tab'/);
});
