import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startHelper, send, waitForOutput, isLifecycle } from './claude-command-lifecycle-harness.mjs';

async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

async function sessionFixture(t, options = {}) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-plugin-helper-test-')));
  const target = path.join(home, '.ccem/agents/claude');
  await write(path.join(target, '.ccem-migration-v1.json'), { version: 1 });
  await write(path.join(target, 'projects/fixture/existing.jsonl'), 'existing-session-data\n');
  const session = await startHelper(t, { pluginRefreshProbe: true, ...options }, {
    working_dir: home,
    provider_session_id: 'mock-session',
  }, { HOME: home, USERPROFILE: home, CCEM_AGENT_HOME: path.join(home, '.ccem/agents') });
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { ...session, home, target };
}

async function installOfficialPlugin(home) {
  const official = path.join(home, '.claude');
  const installPath = path.join(official, 'plugins/cache/market/fixture/1');
  await write(path.join(installPath, '.claude-plugin/plugin.json'), { name: 'fixture', version: '1' });
  await write(path.join(installPath, 'commands/ping.md'), 'Return a harmless fixture response.');
  await write(path.join(official, 'plugins/installed_plugins.json'), {
    version: 2, plugins: { 'fixture@market': [{ scope: 'user', installPath, version: '1' }] },
  });
  await write(path.join(official, 'plugins/known_marketplaces.json'), {
    market: { source: { source: 'github', repo: 'fixture/market' }, installLocation: path.join(official, 'plugins/marketplaces/market') },
  });
  await write(path.join(official, 'plugins/marketplaces/market/.claude-plugin/marketplace.json'), {
    name: 'market', plugins: [{ name: 'fixture', source: { source: 'url', url: 'https://example.invalid/fixture.git' }, version: '1' }],
  });
  await write(path.join(official, 'settings.json'), { enabledPlugins: { 'fixture@market': true } });
  await write(path.join(official, '.credentials.json'), 'official-fixture-token-must-stay-official');
}

function pluginEvents(session, stage) {
  return session.outputs.filter((entry) => entry.type === 'plugin_probe' && entry.stage === stage);
}

async function turn(session, number) {
  send(session, { type: 'prompt', text: `fixture turn ${number}`, command_id: `plugin-${number}` });
  await waitForOutput(session, (entry) => entry.type === 'plugin_probe' && entry.stage === 'idle' && entry.turn === number,
    `plugin turn ${number} idle`);
}

test('helper imports a later plugin before the next idle turn without replacing the query or history', async (t) => {
  const session = await sessionFixture(t);
  await turn(session, 1);
  assert.equal(pluginEvents(session, 'reload').length, 0);
  await installOfficialPlugin(session.home);
  await turn(session, 2);
  await turn(session, 3);
  assert.equal(pluginEvents(session, 'created').length, 1);
  assert.equal(pluginEvents(session, 'closed').length, 0);
  assert.equal(pluginEvents(session, 'reload').length, 1);
  assert.deepEqual(pluginEvents(session, 'settings')[0].settings, {});
  const reloadIndex = session.outputs.findIndex((entry) => entry.type === 'plugin_probe' && entry.stage === 'reload');
  const admittedIndex = session.outputs.findIndex((entry) => isLifecycle(entry, 'command_admitted', 'plugin-2'));
  assert.ok(reloadIndex < admittedIndex);
  const installed = JSON.parse(await fs.readFile(path.join(session.target, 'plugins/installed_plugins.json'), 'utf8'));
  assert.ok(installed.plugins['fixture@market'][0].installPath.startsWith(session.target + path.sep));
  assert.equal(await fs.readFile(path.join(session.target, 'projects/fixture/existing.jsonl'), 'utf8'), 'existing-session-data\n');
  await assert.rejects(fs.access(path.join(session.target, '.credentials.json')), { code: 'ENOENT' });
  assert.equal(session.outputs.some((entry) => entry.type === 'status' && entry.status === 'error'), false);
});

test('helper defers disk import while background work is present, then refreshes after it settles', async (t) => {
  const session = await sessionFixture(t, { scenario: 'plugin_background' });
  await turn(session, 1);
  await installOfficialPlugin(session.home);
  await turn(session, 2);
  assert.equal(pluginEvents(session, 'reload').length, 0);
  await assert.rejects(fs.access(path.join(session.target, 'plugins/installed_plugins.json')), { code: 'ENOENT' });
  await turn(session, 3);
  assert.equal(pluginEvents(session, 'reload').length, 1);
  assert.equal(pluginEvents(session, 'created').length, 1);
  assert.equal(pluginEvents(session, 'closed').length, 0);
});

test('helper defers import after a foreground terminal until the SDK is also idle', async (t) => {
  const session = await sessionFixture(t, { idleDelayMs: 350 });
  send(session, { type: 'prompt', text: 'first', command_id: 'plugin-1' });
  await waitForOutput(session, (entry) => isLifecycle(entry, 'sdk_command_state', 'plugin-1', 'completed'), 'terminal before idle');
  await installOfficialPlugin(session.home);
  await turn(session, 2);
  assert.equal(pluginEvents(session, 'reload').length, 0);
  await assert.rejects(fs.access(path.join(session.target, 'plugins/installed_plugins.json')), { code: 'ENOENT' });
  await turn(session, 3);
  assert.equal(pluginEvents(session, 'reload').length, 1);
});

test('helper reports a refresh failure without failing the prompt and retries on its next idle turn', async (t) => {
  const session = await sessionFixture(t, { pluginReloadFailures: 1 });
  await turn(session, 1);
  await installOfficialPlugin(session.home);
  await turn(session, 2);
  assert.ok(session.outputs.some((entry) => entry.type === 'event' && entry.payload?.type === 'stderr_line'
    && entry.payload.line.includes('fixture plugin reload failure')));
  await turn(session, 3);
  await turn(session, 4);
  assert.equal(pluginEvents(session, 'reload').length, 2);
  assert.equal(pluginEvents(session, 'created').length, 1);
  assert.equal(session.outputs.some((entry) => entry.type === 'status' && entry.status === 'error'), false);
});

test('helper refreshes after authoritative completion when the CLI emits no session state notifications', async (t) => {
  const session = await sessionFixture(t, { omitSessionStateNotifications: true });
  await turn(session, 1);
  await installOfficialPlugin(session.home);
  await turn(session, 2);
  assert.equal(pluginEvents(session, 'reload').length, 1);
  assert.equal(pluginEvents(session, 'created').length, 1);
  assert.equal(pluginEvents(session, 'closed').length, 0);
  const reloadIndex = session.outputs.findIndex((entry) => entry.type === 'plugin_probe' && entry.stage === 'reload');
  const admittedIndex = session.outputs.findIndex((entry) => isLifecycle(entry, 'command_admitted', 'plugin-2'));
  assert.ok(reloadIndex < admittedIndex);
});

test('authoritative completion without session state notifications still defers for live background work', async (t) => {
  const session = await sessionFixture(t, { scenario: 'plugin_background', omitSessionStateNotifications: true });
  await turn(session, 1);
  await installOfficialPlugin(session.home);
  await turn(session, 2);
  assert.equal(pluginEvents(session, 'reload').length, 0);
  await assert.rejects(fs.access(path.join(session.target, 'plugins/installed_plugins.json')), { code: 'ENOENT' });
  await turn(session, 3);
  assert.equal(pluginEvents(session, 'reload').length, 1);
});

test('an explicit requires_action state blocks refresh despite authoritative command completion', async (t) => {
  const session = await sessionFixture(t, { scenario: 'plugin_requires_action' });
  await turn(session, 1);
  await installOfficialPlugin(session.home);
  await turn(session, 2);
  assert.equal(pluginEvents(session, 'reload').length, 0);
  await assert.rejects(fs.access(path.join(session.target, 'plugins/installed_plugins.json')), { code: 'ENOENT' });
  await turn(session, 3);
  assert.equal(pluginEvents(session, 'reload').length, 1);
});
