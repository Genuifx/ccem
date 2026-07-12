import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importControlIpc() {
  const sourcePath = path.join(desktopDir, 'src', 'lib', 'loginBrowserControlIpc.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-login-browser-ipc-'));
  const outputPath = path.join(tempDir, 'loginBrowserControlIpc.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function sampleSnapshot() {
  return {
    session_id: 'session-a',
    profile_id: 'profile-a',
    workspace_id: 'workspace-a',
    runtime_version: '150.0.7871.115',
    control: 'user',
    handoff_epoch: 0,
    current_origin: null,
    status: 'running',
  };
}

function sampleRecentActivity() {
  return {
    artifacts: [{
      kind: 'interaction_snapshot',
      artifact_id: 'artifact-a',
      byte_size: 2048,
      modified_at: '2026-07-11T05:00:00Z',
      immutable: true,
      untrusted: true,
    }],
  };
}

test('control client maps each trusted UI action to one fixed command', async () => {
  const { createLoginBrowserControlClient } = await importControlIpc();
  const calls = [];
  const projected = sampleSnapshot();
  const recentActivity = sampleRecentActivity();
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'browser_login_recent_activity') return recentActivity;
    return command === 'browser_login_control_snapshot' ? projected : {
      ...projected,
      handoff_epoch: projected.handoff_epoch + 1,
    };
  };
  const client = createLoginBrowserControlClient({ invoke, listen: async () => () => {} });

  assert.equal(await client.snapshot(), projected);
  assert.equal(await client.recentActivity(), recentActivity);
  await client.handoff();
  await client.pause();
  await client.takeover();
  await client.close(false);
  await client.close(true);

  assert.deepEqual(calls, [
    ['browser_login_control_snapshot', undefined],
    ['browser_login_recent_activity', undefined],
    ['browser_login_handoff', undefined],
    ['browser_login_pause', undefined],
    ['browser_login_takeover', undefined],
    ['browser_login_close', undefined],
    ['browser_login_force_stop', undefined],
  ]);
});

test('control client forwards only the typed session projection from the event', async () => {
  const { createLoginBrowserControlClient, LOGIN_BROWSER_CONTROL_EVENT } = await importControlIpc();
  const projected = sampleSnapshot();
  let subscribedEvent = null;
  let eventHandler = null;
  let cleanedUp = false;
  const client = createLoginBrowserControlClient({
    invoke: async () => null,
    listen: async (event, handler) => {
      subscribedEvent = event;
      eventHandler = handler;
      return () => { cleanedUp = true; };
    },
  });
  const received = [];
  const unlisten = await client.subscribe((snapshot) => received.push(snapshot));

  eventHandler({ payload: projected });
  unlisten();

  assert.equal(subscribedEvent, LOGIN_BROWSER_CONTROL_EVENT);
  assert.deepEqual(received, [projected]);
  assert.equal(cleanedUp, true);
});
