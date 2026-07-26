import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

test('handoff preserves browser instances while quarantine and stop retire only exact Agent control', async () => {
  const [lib, nativeRuntime, browser] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'lib.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'native_runtime.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser.rs'), 'utf8'),
  ]);

  const managedHandoffStart = lib.indexOf('fn handoff_native_session_to_terminal(');
  const managedHandoffEnd = lib.indexOf('\n\n#[tauri::command]', managedHandoffStart);
  const managedHandoff = lib.slice(managedHandoffStart, managedHandoffEnd);
  assert.doesNotMatch(managedHandoff, /browser_state\.close/);
  assert.doesNotMatch(managedHandoff, /retire_agent_control|BrowserManager/);

  assert.doesNotMatch(nativeRuntime, /fn destroy_browser_session/);
  assert.doesNotMatch(nativeRuntime, /destroy_browser_session\(/);

  const quarantineStart = nativeRuntime.indexOf('fn quarantine_permission_transition(');
  const quarantineEnd = nativeRuntime.indexOf('\n\n    pub fn stop_session', quarantineStart);
  const quarantine = nativeRuntime.slice(quarantineStart, quarantineEnd);
  assert.match(quarantine, /retire_browser_agent_control/);
  assert.match(quarantine, /retire_login_browser_agent_control/);
  assert.doesNotMatch(quarantine, /\.close\(/);

  const stopStart = nativeRuntime.indexOf('pub fn stop_session(');
  const stopEnd = nativeRuntime.indexOf('\n\n    pub fn reconcile_stale_records', stopStart);
  const stop = nativeRuntime.slice(stopStart, stopEnd);
  assert.match(stop, /retire_browser_agent_control/);
  assert.match(stop, /retire_login_browser_agent_control/);
  assert.doesNotMatch(stop, /destroy_browser_session|BrowserManager|\.close\(/);

  const sessionMetaStart = nativeRuntime.indexOf('fn process_helper_stdout_line(');
  const sessionMetaEnd = nativeRuntime.indexOf('\n\n    fn handle_browser_tool_request', sessionMetaStart);
  const sessionMeta = nativeRuntime.slice(sessionMetaStart, sessionMetaEnd);
  assert.match(sessionMeta, /complete_terminal_handoff/);
  assert.doesNotMatch(
    sessionMeta,
    /destroy_browser_session|retire_browser_agent_control/,
  );

  const retireStart = browser.indexOf('pub fn retire_agent_control(');
  const retireEnd = browser.indexOf('\n\n    pub fn policy_changed(', retireStart);
  const retire = browser.slice(retireStart, retireEnd);
  assert.match(retire, /retire_agent_control_state/);
  assert.doesNotMatch(retire, /set_visible|sync_webview_visibility|\\.close\(/);
});
