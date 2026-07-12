import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

test('ready runtime keeps primary create actions and exposes every saved profile for reopen and maintenance', async () => {
  const [source, commands, permissions, tauriIpc, zh, en] = await Promise.all([
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'BrowserLauncherPopover.tsx'),
      'utf8',
    ),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser', 'login_commands.rs'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri', 'permissions', 'trusted-app-commands.toml'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'lib', 'tauri-ipc.ts'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'locales', 'zh.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(desktopDir, 'src', 'locales', 'en.json'), 'utf8').then(JSON.parse),
  ]);

  assert.match(source, /loginBrowserLauncherClient\.open\(workingDir, profileMode\)/);
  assert.match(source, /openLoginBrowser\('new'\)/);
  assert.match(source, /openLoginBrowser\('default'\)/);
  assert.match(source, /aria-label=\{t\('workspace\.loginBrowserNewProfile'\)\}/);
  assert.match(source, /aria-label=\{t\('workspace\.loginBrowserOpenDefault'\)\}/);
  assert.match(source, /loginBrowserLauncherClient\.listProfiles\(workingDir\)/);
  assert.match(source, /profiles\.map\(\(profile\) =>/);
  assert.match(source, /loginBrowserLauncherClient\.openProfile\(workingDir, profile\.profile_id\)/);
  assert.match(
    source,
    /loginBrowserLauncherClient\.profileRecentActivity\(\s*workingDir,\s*profile\.profile_id/,
  );
  assert.match(source, /summarizeSavedProfileRecentProof/);
  assert.match(source, /loginProfileRecentProof/);
  assert.match(
    source,
    /loginBrowserLauncherClient\.resetProfile\(\s*workingDir,\s*profile\.profile_id,\s*true/,
  );
  assert.match(
    source,
    /loginBrowserLauncherClient\.deleteProfile\(\s*workingDir,\s*profile\.profile_id,\s*true/,
  );
  assert.match(source, /profileRequestGenerationRef/);
  assert.match(source, /profileState && profileState\.workingDir === workingDir/);
  assert.match(source, /max-h-\[220px\][^"\n]*overflow-y-auto/);
  assert.match(source, /loginProfileResetConfirm'[\s\S]*compactProfileId\(profile\.profile_id\)/);
  assert.match(source, /loginProfileDeleteConfirm'[\s\S]*compactProfileId\(profile\.profile_id\)/);
  assert.match(source, /loginProfilesUnavailable/);
  assert.match(source, /aria-label=\{`\$\{t\('workspace\.loginProfileReset'\)\}/);
  assert.match(source, /aria-label=\{`\$\{t\('workspace\.loginProfileDelete'\)\}/);
  assert.match(commands, /fn ensure_trusted_main_window\(window: &WebviewWindow\)/);
  assert.equal(commands.match(/ensure_trusted_main_window\(&window\)\?/g)?.length, 6);
  for (const command of [
    'browser_login_profiles',
    'browser_login_open_profile',
    'browser_login_profile_recent_activity',
    'browser_login_reset_profile',
    'browser_login_delete_profile',
  ]) {
    assert.match(commands, new RegExp(`fn ${command}\\(`));
    assert.match(permissions, new RegExp(`"${command}"`));
    assert.match(tauriIpc, new RegExp(`${command}:`));
  }
  assert.equal(zh.workspace.loginBrowserNewProfile, '新建隔离配置');
  assert.equal(en.workspace.loginBrowserNewProfile, 'New isolated profile');
  assert.equal(zh.workspace.loginBrowserOpenDefault, '打开默认配置');
  assert.equal(en.workspace.loginBrowserOpenDefault, 'Open default profile');
  assert.equal(zh.workspace.loginSavedProfiles, '已保存配置');
  assert.equal(en.workspace.loginSavedProfiles, 'Saved profiles');
  assert.equal(zh.workspace.loginProfileOpen, '打开');
  assert.equal(en.workspace.loginProfileOpen, 'Open');
  assert.equal(zh.workspace.loginProfileRecentProof, '最近证据');
  assert.equal(en.workspace.loginProfileRecentProof, 'Recent proof');
  assert.equal(zh.workspace.loginProfileReset, '重置登录数据');
  assert.equal(en.workspace.loginProfileReset, 'Reset login data');
  assert.equal(zh.workspace.loginProfileDelete, '删除配置');
  assert.equal(en.workspace.loginProfileDelete, 'Delete profile');
});
