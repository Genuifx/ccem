import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const tauriSrcDir = path.join(desktopDir, 'src-tauri', 'src');

test('macOS traffic light position includes the overlay titlebar visual offset', async () => {
  const [configSource, styles] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'index.css'), 'utf8'),
  ]);

  const config = JSON.parse(configSource);
  const mainWindow = config.app.windows[0];
  const readPixelVar = (name) => {
    const match = styles.match(new RegExp(`${name}:\\s*(\\d+)px`));
    assert.ok(match, `${name} should be declared as a px variable`);
    return Number(match[1]);
  };

  const controlCenter = readPixelVar('--ccem-titlebar-control-center-y');
  const controlHalfSize = readPixelVar('--ccem-window-controls-half-size');
  const webTitlebarControlTop = controlCenter - controlHalfSize;
  // Tauri applies the native control position in the macOS overlay titlebar
  // coordinate space, while the web titlebar row paints slightly lower.
  const nativeOverlayOffsetY = 10;

  assert.equal(mainWindow.decorations, true);
  assert.equal(mainWindow.titleBarStyle, 'Overlay');
  assert.equal(mainWindow.hiddenTitle, true);
  assert.deepEqual(mainWindow.trafficLightPosition, {
    x: 24,
    y: webTitlebarControlTop + nativeOverlayOffsetY,
  });
});

test('macOS chrome avoids runtime traffic light repositioning', async () => {
  const [mainSource, traySource, petNotificationSource, fullscreenControls] = await Promise.all([
    fs.readFile(path.join(tauriSrcDir, 'lib.rs'), 'utf8'),
    fs.readFile(path.join(tauriSrcDir, 'tray.rs'), 'utf8'),
    fs.readFile(path.join(tauriSrcDir, 'pet_notifications.rs'), 'utf8'),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'layout', 'MacFullscreenWindowControls.tsx'),
      'utf8',
    ),
  ]);

  const combinedBackendSource = [mainSource, traySource, petNotificationSource].join('\n');

  assert.doesNotMatch(combinedBackendSource, /schedule_macos_traffic_light_sync_series/);
  assert.doesNotMatch(combinedBackendSource, /set_traffic_lights_inset/);
  assert.doesNotMatch(mainSource, /WindowEvent::Resized[\s\S]*traffic/i);
  assert.match(
    mainSource,
    /#\[cfg\(not\(target_os = "macos"\)\)\]\s*let builder = builder\.plugin\(tauri_plugin_decorum::init\(\)\);/,
  );
  assert.doesNotMatch(fullscreenControls, /will-enter-fullscreen|did-enter-fullscreen|did-exit-fullscreen/);
  assert.match(
    fullscreenControls,
    /currentWindow\.onResized\(scheduleSync\)[\s\S]*currentWindow\.onFocusChanged\(scheduleSync\)[\s\S]*currentWindow\.onScaleChanged\(scheduleSync\)/,
  );
});

test('visible-window restore paths keep showing and focusing the window', async () => {
  const [mainSource, traySource, petNotificationSource] = await Promise.all([
    fs.readFile(path.join(tauriSrcDir, 'lib.rs'), 'utf8'),
    fs.readFile(path.join(tauriSrcDir, 'tray.rs'), 'utf8'),
    fs.readFile(path.join(tauriSrcDir, 'pet_notifications.rs'), 'utf8'),
  ]);

  assert.match(
    mainSource,
    /main_window\.show\(\)[\s\S]*main_window\.set_focus\(\)/,
  );
  assert.match(
    traySource,
    /"open_window"[\s\S]*window\.show\(\)[\s\S]*window\.unminimize\(\)[\s\S]*window\.set_focus\(\)/,
  );
  assert.match(
    traySource,
    /"settings"[\s\S]*window\.show\(\)[\s\S]*window\.unminimize\(\)[\s\S]*window\.set_focus\(\)/,
  );
  assert.match(
    petNotificationSource,
    /main_window\.show\(\)[\s\S]*main_window\.unminimize\(\)[\s\S]*main_window\.set_focus\(\)/,
  );
});
