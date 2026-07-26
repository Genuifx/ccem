import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importLauncherIpc() {
  const sourcePath = path.join(desktopDir, 'src', 'lib', 'loginBrowserLauncherIpc.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-login-browser-launcher-'));
  const outputPath = path.join(tempDir, 'loginBrowserLauncherIpc.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('launcher exposes inventory and per-profile maintenance without legacy launch IPC', async () => {
  const { createLoginBrowserLauncherClient } = await importLauncherIpc();
  const calls = [];
  const projected = { session_id: 'session-a' };
  const client = createLoginBrowserLauncherClient({
    invoke: async (command, args) => {
      calls.push([command, args]);
      return projected;
    },
  });

  assert.equal(await client.listProfiles('/tmp/project'), projected);
  assert.equal(await client.profileRecentActivity('/tmp/project', 'profile-b'), projected);
  assert.equal(await client.resetProfile('/tmp/project', 'profile-a', false), projected);
  assert.equal(await client.resetProfile('/tmp/project', 'profile-a', true), projected);
  assert.equal(await client.deleteProfile('/tmp/project', 'profile-a', false), projected);
  assert.equal(await client.deleteProfile('/tmp/project', 'profile-a', true), projected);
  assert.deepEqual(calls, [
    ['browser_login_profiles', { workingDir: '/tmp/project' }],
    ['browser_login_profile_recent_activity', {
      workingDir: '/tmp/project', profileId: 'profile-b',
    }],
    ['browser_login_reset_profile', {
      workingDir: '/tmp/project', profileId: 'profile-a', confirmed: false,
    }],
    ['browser_login_reset_profile', {
      workingDir: '/tmp/project', profileId: 'profile-a', confirmed: true,
    }],
    ['browser_login_delete_profile', {
      workingDir: '/tmp/project', profileId: 'profile-a', confirmed: false,
    }],
    ['browser_login_delete_profile', {
      workingDir: '/tmp/project', profileId: 'profile-a', confirmed: true,
    }],
  ]);
});
