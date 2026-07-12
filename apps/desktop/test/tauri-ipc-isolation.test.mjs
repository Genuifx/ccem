import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const desktopDir = path.resolve(import.meta.dirname, '..');
const tauriDir = path.join(desktopDir, 'src-tauri');

function extractRegisteredAppCommands(source) {
  const block = source.match(
    /\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\n\s*\]\)/,
  )?.[1];
  assert.ok(block, 'main.rs must contain the Tauri generate_handler command list');

  return block
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split('::').at(-1));
}

function extractAllowedManifestCommands(source) {
  const block = source.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(block, 'trusted app permission must declare commands.allow');
  return [...block.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must not contain duplicates`);
}

test('Tauri capabilities grant desktop privileges only to trusted app webviews', async () => {
  const capabilitiesDir = path.join(tauriDir, 'capabilities');
  const [tauriConfigSource, capabilitySource, capabilityFiles] = await Promise.all([
    fs.readFile(path.join(tauriDir, 'tauri.conf.json'), 'utf8'),
    fs.readFile(path.join(capabilitiesDir, 'default.json'), 'utf8'),
    fs.readdir(capabilitiesDir),
  ]);
  const tauriConfig = JSON.parse(tauriConfigSource);
  const capability = JSON.parse(capabilitySource);

  assert.equal(tauriConfig.app.withGlobalTauri, false);
  assert.deepEqual(capability.webviews, ['main', 'desktop-pet', 'tray-cockpit']);
  assert.ok(capability.permissions.includes('trusted-app-commands'));
  assert.ok(!capability.webviews.includes('browser'));
  assert.ok(
    capability.webviews.every((label) => !label.includes('*')),
    'trusted capability labels must not use globs that can match browser-* webviews',
  );

  for (const file of capabilityFiles.filter((name) => name.endsWith('.json'))) {
    const candidate = JSON.parse(
      await fs.readFile(path.join(capabilitiesDir, file), 'utf8'),
    );
    assert.equal(
      Object.hasOwn(candidate, 'windows'),
      false,
      `${file}: window-scoped capabilities leak into every child webview in that window`,
    );
    assert.ok(
      (candidate.webviews ?? []).every(
        (label) => !label.startsWith('browser') && !label.includes('*'),
      ),
      `${file}: privileged capabilities must use exact trusted app webview labels`,
    );
  }
});

test('trusted command ACLs stay in lockstep with generate_handler', async () => {
  const [mainSource, permissionFiles] = await Promise.all([
    fs.readFile(path.join(tauriDir, 'src', 'main.rs'), 'utf8'),
    fs.readdir(path.join(tauriDir, 'permissions')),
  ]);
  const registered = extractRegisteredAppCommands(mainSource);
  const allowed = (
    await Promise.all(
      permissionFiles
        .filter((name) => name.endsWith('.toml'))
        .map(async (name) => extractAllowedManifestCommands(
          await fs.readFile(path.join(tauriDir, 'permissions', name), 'utf8'),
        )),
    )
  ).flat();

  assertUnique(registered, 'generate_handler command list');
  assertUnique(allowed, 'trusted command ACL union');
  assert.deepEqual(
    [...allowed].sort(),
    [...registered].sort(),
    'every registered app command must be explicitly covered by one trusted webview ACL',
  );
});

test('Login Browser control has an exact least-privilege capability', async () => {
  const [capabilitySource, permissionSource, defaultPermissionSource] = await Promise.all([
    fs.readFile(path.join(tauriDir, 'capabilities', 'login-browser-control.json'), 'utf8'),
    fs.readFile(
      path.join(tauriDir, 'permissions', 'login-browser-control-commands.toml'),
      'utf8',
    ),
    fs.readFile(
      path.join(tauriDir, 'permissions', 'trusted-app-commands.toml'),
      'utf8',
    ),
  ]);
  const capability = JSON.parse(capabilitySource);
  const commands = extractAllowedManifestCommands(permissionSource);

  assert.deepEqual(capability.webviews, ['login-browser-control']);
  assert.ok(capability.permissions.includes('login-browser-control-commands'));
  assert.deepEqual(commands.sort(), [
    'browser_login_close',
    'browser_login_control_snapshot',
    'browser_login_force_stop',
    'browser_login_handoff',
    'browser_login_pause',
    'browser_login_recent_activity',
    'browser_login_takeover',
  ]);
  for (const command of commands) {
    assert.doesNotMatch(defaultPermissionSource, new RegExp(`"${command}"`));
  }
});
