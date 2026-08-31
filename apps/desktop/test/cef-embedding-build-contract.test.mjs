import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = path.join(desktopDir, 'src-tauri');

test('embedded Login Browser pins CEF and splits macOS helper from Windows sandbox bootstrap', async () => {
  const [cargo, lockfile, helper, windowsBootstrap, windowsRuntime, producer] = await Promise.all([
    fs.readFile(path.join(tauriDir, 'Cargo.toml'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'Cargo.lock'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'bin', 'ccem_cef_helper.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'windows_bootstrap.rs'), 'utf8'),
    fs.readFile(path.join(
      tauriDir,
      'src',
      'browser',
      'login',
      'cef',
      'bootstrap',
      'windows.rs',
    ), 'utf8'),
    fs.readFile(path.join(desktopDir, 'scripts', 'produce-cef-windows-sandbox.mjs'), 'utf8'),
  ]);

  assert.match(
    cargo,
    /cef\s*=\s*\{\s*version\s*=\s*"=150\.0\.0"\s*,\s*default-features\s*=\s*false\s*,\s*features\s*=\s*\[\s*"sandbox"\s*,\s*"build-util"\s*\]/,
  );
  assert.match(
    lockfile,
    /\[\[package\]\]\s+name\s*=\s*"cef"\s+version\s*=\s*"150\.0\.0\+150\.0\.10"/,
  );
  assert.match(cargo, /\[\[bin\]\][\s\S]*name\s*=\s*"ccem-cef-helper"/);
  assert.match(
    cargo,
    /\[package\.metadata\.cef\.bundle\][\s\S]*helper_name\s*=\s*"ccem-cef-helper"/,
  );
  assert.match(cargo, /\[lib\]\s+name\s*=\s*"ccem_desktop"\s+path\s*=\s*"src\/lib\.rs"/);
  assert.doesNotMatch(cargo, /crate-type\s*=\s*\[[^\]]*"cdylib"/,
    'ordinary Cargo builds must remain rlib/bin builds');

  const loadIndex = helper.indexOf('loader.load()');
  const apiIndex = helper.indexOf('api_hash(');
  const argsIndex = helper.indexOf('Args::new()');
  assert.ok(loadIndex > 0, 'helper must load the bundled CEF framework');
  assert.ok(apiIndex > loadIndex, 'CEF API table must initialize after framework load');
  assert.ok(argsIndex > apiIndex, 'CEF values must not be constructed before API initialization');
  const sandboxIndex = helper.indexOf('sandbox.initialize(');
  assert.ok(sandboxIndex > argsIndex, 'macOS sandbox must initialize after CEF Args exist');
  assert.match(helper, /execute_process\(/);

  assert.match(
    windowsBootstrap,
    /pub unsafe extern "C" fn RunWinMain\(\s*instance: cef::sys::HINSTANCE,\s*_command_line: \*mut u16,\s*_command_show: i32,\s*sandbox_info: \*mut u8,\s*version_info: \*mut c_void,\s*\) -> i32/,
    'the official CEF bootstrap ABI must retain all five pointer-sized argument slots',
  );
  const windowsApiIndex = windowsBootstrap.indexOf('cef::api_hash(');
  const windowsExecuteIndex = windowsBootstrap.indexOf('cef::execute_process(');
  const windowsAppIndex = windowsBootstrap.indexOf('crate::run_desktop_app()');
  assert.ok(windowsApiIndex > 0 && windowsExecuteIndex > windowsApiIndex);
  assert.ok(windowsAppIndex > windowsExecuteIndex);
  assert.match(windowsBootstrap, /context\.sandbox_info\(\)/);
  assert.doesNotMatch(windowsBootstrap, /std::process::exit\s*\(/,
    'RunWinMain must return so bootstrap.exe can execute broker cleanup');

  assert.match(windowsRuntime, /Some\(context\) => \(0, CefString::default\(\), context\.sandbox_info\(\)\)/);
  assert.match(windowsRuntime, /None =>[\s\S]*?\(1, browser_subprocess_path, std::ptr::null_mut\(\)\)/);
  assert.match(windowsRuntime, /Windows Mode 2 release requires the official CEF bootstrap sandbox context/);
  assert.match(helper, /not\(debug_assertions\)[\s\S]*?official CEF bootstrap[\s\S]*?exit\(78\)/);
  assert.match(producer, /'rustc'[\s\S]*?'--lib', '--crate-type', 'cdylib'/,
    'only the Windows producer may request a cdylib crate type');
});

test('CEF startup never calls utility APIs before cef_initialize', async () => {
  const cefDir = path.join(tauriDir, 'src', 'browser', 'login', 'cef');
  const entries = await fs.readdir(cefDir, { withFileTypes: true });
  const sources = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.rs'))
    .map(async (entry) => ({
      name: entry.name,
      source: await fs.readFile(path.join(cefDir, entry.name), 'utf8'),
    })));

  for (const { name, source } of sources) {
    assert.doesNotMatch(
      source,
      /\b(?:cef::)?base64_encode\s*\(/,
      `${name} must use a non-CEF encoder; cef_base64encode before initialize traps in CEF 150`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:cef::)?uriencode\s*\(/,
      `${name} must keep all non-bootstrap CEF utilities out of the preinitialize path`,
    );
  }
});

test('legacy external Login Browser launch and control surfaces are absent', async () => {
  const [main, permission, roots, capabilities] = await Promise.all([
    fs.readFile(path.join(tauriDir, 'src', 'lib.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'permissions', 'trusted-app-commands.toml'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'lib', 'windowRootRouting.ts'), 'utf8'),
    fs.readdir(path.join(tauriDir, 'capabilities')),
  ]);
  await assert.rejects(
    fs.access(path.join(desktopDir, 'src', 'lib', 'loginBrowserLauncherIpc.ts')),
  );
  const legacyCommands = [
    'browser_login_open',
    'browser_login_open_profile',
    'browser_login_control_snapshot',
    'browser_login_recent_activity',
    'browser_login_handoff',
    'browser_login_pause',
    'browser_login_takeover',
    'browser_login_close',
    'browser_login_force_stop',
    'browser_login_profiles',
    'browser_login_profile_recent_activity',
    'browser_login_reset_profile',
    'browser_login_delete_profile',
  ];

  for (const command of legacyCommands) {
    assert.doesNotMatch(main, new RegExp(`login_commands::${command}\\b`));
    assert.doesNotMatch(permission, new RegExp(`"${command}"`));
  }
  assert.doesNotMatch(roots, /login-browser-control/);
  assert.ok(!capabilities.includes('login-browser-control.json'));
});

test('windowed CEF close stays inside BrowserPanel, drains before AppKit exits, and finalizes afterward', async () => {
  const [surface, popup, pump, bootstrap, host, main] = await Promise.all([
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'surface', 'macos.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'surface', 'macos', 'popup.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'pump.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'bootstrap.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'host.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'lib.rs'), 'utf8'),
  ]);

  const doClose = surface.slice(surface.indexOf('fn do_close('), surface.indexOf('fn on_before_close('));
  const layerBackedIndex = surface.indexOf('parent.setWantsLayer(true)');
  const browserCreateIndex = surface.indexOf('browser_host_create_browser_sync', layerBackedIndex);
  assert.ok(layerBackedIndex > 0 && layerBackedIndex < browserCreateIndex,
    'the external Wry parent must be layer-backed before CEF creates child views');
  assert.match(doClose, /removeFromSuperview\(\)/, 'DoClose must remove only the native CEF child');
  assert.match(doClose, /\n\s*1\n/, 'DoClose must handle the close instead of propagating performClose:');
  assert.match(surface, /fn on_before_popup\([\s\S]*?popup::configure_user_popup\(/,
    'the root browser must delegate popup admission to the owned OAuth popup path');
  assert.match(popup, /if user_gesture != 1[\s\S]*?return reject\("no_user_gesture"\)/,
    'scripted popups must remain blocked');
  assert.match(popup, /popup_disposition_allowed\(target_disposition\)/,
    'only foreground popup dispositions may enter the owned path');
  assert.match(popup, /popup_url_allowed\(&target_url\)/,
    'popup URLs must be constrained before native creation');
  assert.match(popup, /reserve_user_popup\(popup_id, target_url\.clone\(\)\)/,
    'shared admission must reserve the single popup before CEF creation');
  assert.match(popup, /\.set_as_child\(parent(?:\.cast\(\))?, &rect\)/,
    'the popup must remain a child of the BrowserPanel native parent');
  assert.match(popup, /\*client = Some\(PopupSurfaceClient::new\(/,
    'the original CEF popup must use a dedicated owned client');
  assert.match(popup, /no_javascript_access[\s\S]*?0\n\}/,
    'the original popup must be accepted without severing opener JavaScript access');
  assert.doesNotMatch(popup, /\*no_javascript_access\s*=/,
    'window.opener, postMessage, and window.closed must retain CEF semantics');

  const nestedPopup = popup.slice(
    popup.indexOf('struct PopupLifeSpanHandler'),
    popup.indexOf('fn on_after_created', popup.indexOf('struct PopupLifeSpanHandler')),
  );
  assert.match(nestedPopup, /fn on_before_popup\([\s\S]*?\n\s*1\n\s*\}/,
    'nested popups must fail closed until the ownership model supports them');
  assert.match(popup, /expected\.is_same\(Some\(&mut actual\)\) == 1/,
    'the popup must prove it stayed in the opener RequestContext');
  assert.match(popup, /fn on_before_browse\([\s\S]*?popup_url_allowed\(&url\)[\s\S]*?\n\s*1\n\s*\}/,
    'popup redirects must remain inside about:blank or HTTP/HTTPS navigation');
  assert.match(popup, /fn on_open_urlfrom_tab\([\s\S]*?\n\s*1\n\s*\}/,
    'a popup must not create an unowned second tab or window');
  assert.match(surface, /surface\.primary_closed && surface\.popup\.is_none\(\)/,
    'surface finalization must wait for both the root browser and popup');

  assert.match(pump, /PumpPhase::Running[\s\S]*PumpPhase::Draining[\s\S]*PumpPhase::Stopped/);
  assert.match(pump, /drain_before_app_loop_exit/,
    'CEF must perform its bounded drain while Tao still owns a live event callback');
  assert.doesNotMatch(bootstrap, /drain_after_app_loop/,
    'pumping CFRunLoop after run_return would dispatch into Tao after its callback is destroyed');
  assert.doesNotMatch(surface, /POST_CLOSE_DRAIN/,
    'surface close must not guess at a pre-exit wall-clock drain');
  assert.match(bootstrap, /pub\(crate\) fn prepare_shutdown\(/);
  const closeAllIndex = bootstrap.indexOf('surface::macos::shutdown_all(&self.pump)?');
  const preExitDrainIndex = bootstrap.indexOf('self.pump.drain_before_app_loop_exit()?');
  assert.ok(closeAllIndex > 0 && preExitDrainIndex > closeAllIndex,
    'CEF must close exact child surfaces before the bounded pre-exit drain');
  assert.match(bootstrap, /pub\(crate\) fn finish_shutdown\(/);
  assert.match(host, /prepare_shutdown_current_thread/);
  assert.match(host, /finish_shutdown_current_thread/);
  const prepareIndex = main.indexOf('shutdown_cef.prepare_shutdown(&shutdown_app)');
  const finalQuitIndex = main.indexOf('shutdown_app.exit(requested_code)', prepareIndex);
  assert.ok(prepareIndex > 0 && finalQuitIndex > prepareIndex,
    'the first quit request must remain prevented until CEF pre-exit preparation finishes');
  const runReturnIndex = main.indexOf('.run_return(');
  const finishIndex = main.indexOf('finish_shutdown_current_thread()');
  assert.ok(runReturnIndex > 0 && finishIndex > runReturnIndex,
    'cef_shutdown finalization must happen only after the AppKit event loop returns');

  const closedGate = surface.slice(surface.indexOf('fn all_surfaces_closed('));
  assert.doesNotMatch(closedGate, /CefSurfaceLifecycle::Failed/,
    'Failed is not evidence that Browser OnBeforeClose completed');
});

test('Windows CEF children start hidden when the current lease is hidden and close locally', async () => {
  const [surface, popup, util, pump, platformPump, bootstrap] = await Promise.all([
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'surface', 'windows.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'surface', 'windows', 'popup.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'surface', 'windows', 'util.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'pump.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'pump', 'windows.rs'), 'utf8'),
    fs.readFile(path.join(tauriDir, 'src', 'browser', 'login', 'cef', 'bootstrap', 'windows.rs'), 'utf8'),
  ]);

  assert.match(surface, /if !visible \{[\s\S]*window_info\.style &= !WS_VISIBLE\.0/,
    'primary HWND must not flash before the hidden acquire lease is synced');
  assert.match(popup, /Ok\(\(surface\.bounds, surface\.visible\)\)/);
  assert.match(popup, /if !visible \{[\s\S]*window_info\.style &= !WS_VISIBLE\.0/,
    'popup HWND creation must inherit an occluded parent state');
  assert.match(util, /DestroyWindow\(hwnd\)[\s\S]*PostMessageW\(Some\(hwnd\), WM_CLOSE/,
    'a failed direct teardown must retry only the CEF child instead of the Tauri parent');
  assert.match(platformPump, /timer_pending = timer_registration_succeeded\(timer_id\)/,
    'SetTimer failure must not masquerade as pending future work');
  assert.match(pump, /if !timer_started \{[\s\S]*self\.do_scheduled_work\(\)/,
    'timer failure must fall back to a CEF tick instead of stalling the pump');
  assert.match(pump, /#\[cfg\(windows\)\][\s\S]*drain_after_app_loop/,
    'Windows must retain its post-run-loop shutdown drain API');
  assert.match(bootstrap, /self\.pump\.drain_after_app_loop\(\)/,
    'Windows must call the platform-specific drain before cef_shutdown');
});
