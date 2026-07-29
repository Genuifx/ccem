import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importSessionLaunchAction() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'sessions',
    'sessionLaunchAction.ts',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ccem-session-launch-action-test-'),
  );
  const outputPath = path.join(tempDir, 'sessionLaunchAction.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('calls onLaunch when no working dir is selected', async () => {
  const { launchSingleSession } = await importSessionLaunchAction();
  const calls = [];

  const result = await launchSingleSession({
    selectedWorkingDir: null,
    onLaunch: async (client) => { calls.push(['onLaunch', client]); },
    onLaunchWithDir: async () => { calls.push('onLaunchWithDir'); },
  });

  assert.deepEqual(result, { launched: true, workingDir: null });
  assert.deepEqual(calls, [['onLaunch', 'claude']]);
});

test('calls onLaunchWithDir when a working dir is selected', async () => {
  const { launchSingleSession } = await importSessionLaunchAction();
  const calls = [];

  const result = await launchSingleSession({
    selectedWorkingDir: '/tmp/project',
    onLaunch: async () => { calls.push('onLaunch'); },
    onLaunchWithDir: async (dir, client) => { calls.push(['onLaunchWithDir', dir, client]); },
  });

  assert.deepEqual(result, { launched: true, workingDir: '/tmp/project' });
  assert.deepEqual(calls, [['onLaunchWithDir', '/tmp/project', 'claude']]);
});

test('uses an explicit launch client when supplied', async () => {
  const { launchSingleSession } = await importSessionLaunchAction();
  const calls = [];

  const result = await launchSingleSession({
    selectedWorkingDir: '/tmp/project',
    client: 'opencode',
    onLaunch: async () => { calls.push('onLaunch'); },
    onLaunchWithDir: async (dir, client) => { calls.push(['onLaunchWithDir', dir, client]); },
  });

  assert.deepEqual(result, { launched: true, workingDir: '/tmp/project' });
  assert.deepEqual(calls, [['onLaunchWithDir', '/tmp/project', 'opencode']]);
});

test('rejects when onLaunch rejects, without calling onLaunchWithDir', async () => {
  const { launchSingleSession } = await importSessionLaunchAction();
  let onLaunchWithDirCalled = false;

  await assert.rejects(
    launchSingleSession({
      selectedWorkingDir: null,
      onLaunch: async () => { throw new Error('boom'); },
      onLaunchWithDir: async () => { onLaunchWithDirCalled = true; },
    }),
    { message: 'boom' },
  );
  assert.equal(onLaunchWithDirCalled, false);
});

test('rejects when onLaunchWithDir rejects', async () => {
  const { launchSingleSession } = await importSessionLaunchAction();

  await assert.rejects(
    launchSingleSession({
      selectedWorkingDir: '/tmp/project',
      onLaunch: async () => {},
      onLaunchWithDir: async () => { throw new Error('dir-boom'); },
    }),
    { message: 'dir-boom' },
  );
});

test('rejects duplicate in-flight launch instead of reporting success', async () => {
  const { runExclusiveLaunch } = await importSessionLaunchAction();
  const inFlight = new Set();
  let releaseFirstLaunch;

  const firstLaunch = runExclusiveLaunch(inFlight, 'dir:claude:/tmp/project', async () => {
    await new Promise((resolve) => {
      releaseFirstLaunch = resolve;
    });
  });

  await assert.rejects(
    runExclusiveLaunch(inFlight, 'dir:claude:/tmp/project', async () => {
      throw new Error('should not run duplicate launch');
    }),
    {
      name: 'LaunchAlreadyInProgressError',
      message: 'Session launch is already in progress for this target.',
    },
  );

  releaseFirstLaunch();
  await firstLaunch;
});

test('clears in-flight launch key after failure', async () => {
  const { runExclusiveLaunch } = await importSessionLaunchAction();
  const inFlight = new Set();
  const calls = [];

  await assert.rejects(
    runExclusiveLaunch(inFlight, 'default:claude', async () => {
      calls.push('failed');
      throw new Error('launch failed');
    }),
    { message: 'launch failed' },
  );

  await runExclusiveLaunch(inFlight, 'default:claude', async () => {
    calls.push('retried');
  });

  assert.deepEqual(calls, ['failed', 'retried']);
});

test('extracts actionable details only from session command exit errors', async () => {
  const { getSessionCommandExitDetails } = await importSessionLaunchAction();
  const details = 'session command exited during launch (exit code 127); pane output: missing';

  assert.equal(
    getSessionCommandExitDetails(`session_command_exited: ${details}`),
    details,
  );
  assert.equal(
    getSessionCommandExitDetails(new Error(`session_command_exited: ${details}`)),
    details,
  );
  assert.equal(getSessionCommandExitDetails(new Error('generic launch failure')), null);
  assert.equal(
    getSessionCommandExitDetails(new Error(`generic failure: session_command_exited: ${details}`)),
    null,
  );
});
