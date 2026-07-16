import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const spikeSource = await readFile(
  new URL('../src-tauri/src/browser/chromium_spike.rs', import.meta.url),
  'utf8',
);
const spikeTests = await readFile(
  new URL('../src-tauri/src/browser/chromium_spike_tests.rs', import.meta.url),
  'utf8',
);
const browserSource = await readFile(
  new URL('../src-tauri/src/browser.rs', import.meta.url),
  'utf8',
);
const bootstrapSource = await readFile(
  new URL('../src-tauri/src/browser/bootstrap.rs', import.meta.url),
  'utf8',
);
const sessionSource = await readFile(
  new URL('../src-tauri/src/browser/login/session.rs', import.meta.url),
  'utf8',
);
const sessionTypesSource = await readFile(
  new URL('../src-tauri/src/browser/login/session_types.rs', import.meta.url),
  'utf8',
);
const mainSource = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const permissionsSource = await readFile(
  new URL('../src-tauri/permissions/trusted-app-commands.toml', import.meta.url),
  'utf8',
);
const ipcSource = await readFile(new URL('../src/lib/tauri-ipc.ts', import.meta.url), 'utf8');

test('managed Chromium spike uses private FD 3/4 CDP instead of a debug TCP port', () => {
  assert.match(spikeSource, /"--remote-debugging-pipe"/);
  assert.match(spikeSource, /libc::dup2\(command_fd, 3\)/);
  assert.match(spikeSource, /libc::dup2\(response_fd, 4\)/);
  assert.match(spikeSource, /encoded\.push\(0\)/);
  assert.doesNotMatch(spikeSource, /--remote-debugging-port/);
  assert.match(spikeTests, /debug_tcp_listeners\.is_empty\(\)/);
  assert.match(spikeSource, /let deadline = Instant::now\(\) \+ CDP_RESPONSE_TIMEOUT/);
  assert.match(spikeSource, /read_message\(deadline\)/);
});

test('spike runtime path requires explicit feature opt-in and never uses a product cache dependency', () => {
  assert.match(browserSource, /cfg\(all\(unix, feature = "chromium-spike"\)\)/);
  assert.doesNotMatch(browserSource, /any\(test, feature = "chromium-spike"\)/);
  assert.match(spikeTests, /CCEM_CHROMIUM_SPIKE_BINARY/);
  assert.doesNotMatch(spikeSource, /ms-playwright|Google Chrome\.app|\/Users\//);
  assert.match(spikeSource, /--ccem-managed-runtime-id=/);
  assert.match(spikeSource, /--user-data-dir=/);
  assert.match(spikeSource, /Keep metadata when cleanup did not finish/);
  assert.match(spikeSource, /Never discard the only safe process identity on a signal alone/);
});

test('production Mode 2 bootstrap cannot construct the retired external Chromium chain', () => {
  const bootstrapStart = bootstrapSource.indexOf('create_login_browser_session_manager');
  const bootstrapEnd = bootstrapSource.indexOf('create_login_browser_surface_manager');
  const sessionStart = sessionSource.indexOf('pub(crate) fn production(root: PathBuf)');
  const sessionEnd = sessionSource.indexOf('#[cfg(test)]\n    fn from_parts', sessionStart);
  assert.notEqual(bootstrapStart, -1);
  assert.notEqual(bootstrapEnd, -1);
  assert.notEqual(sessionStart, -1);
  assert.notEqual(sessionEnd, -1);

  const bootstrapConstructor = bootstrapSource.slice(bootstrapStart, bootstrapEnd);
  const productionConstructor = sessionSource.slice(sessionStart, sessionEnd);
  assert.doesNotMatch(bootstrapConstructor, /RuntimePaths|ActivationStore|BrowserRuntimeManager/);
  assert.doesNotMatch(productionConstructor, /ActivationStore|LoginSupervisor|supervisor/);
  assert.match(sessionSource, /include!\("session_types\.rs"\)/);
  assert.match(sessionTypesSource, /#\[cfg\(test\)\]\s+trait SessionSupervisor/);
  assert.match(sessionSource, /#\[cfg\(test\)\]\s+pub\(crate\) fn open_default_profile/);
  assert.match(sessionSource, /#\[cfg\(test\)\]\s+pub\(in crate::browser::login\) fn prepare_profile/);
});

test('legacy downloadable Chromium runtime has no production IPC surface', () => {
  assert.doesNotMatch(mainSource, /browser::runtime_commands::browser_runtime_/);
  assert.doesNotMatch(permissionsSource, /"browser_runtime_/);
  assert.doesNotMatch(ipcSource, /browser_runtime_[a-z_]+:/);
});
