import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

test('dedicated Login Browser control root uses the typed projection adapter', async () => {
  const [entrySource, pageSource, cssSource, capability, zh, en] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src', 'main.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'pages', 'LoginBrowserControl.tsx'), 'utf8'),
    fs.readFile(
      path.join(desktopDir, 'src', 'components', 'login-browser', 'loginBrowserControl.css'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src-tauri', 'capabilities', 'login-browser-control.json'),
      'utf8',
    ).then(JSON.parse),
    fs.readFile(path.join(desktopDir, 'src', 'locales', 'zh.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(desktopDir, 'src', 'locales', 'en.json'), 'utf8').then(JSON.parse),
  ]);

  assert.match(entrySource, /import \{ LoginBrowserControl \}/);
  assert.match(entrySource, /case 'login-browser-control':[\s\S]*return LoginBrowserControl/);
  assert.match(pageSource, /tauriLoginBrowserControlClient/);
  assert.doesNotMatch(pageSource, /invoke\s*\(/);
  assert.match(pageSource, /data-tauri-drag-region/);
  assert.match(pageSource, /deriveLoginBrowserControlModel/);
  assert.match(pageSource, /controlClient\.subscribe/);
  assert.match(pageSource, /controlClient\.recentActivity/);
  assert.match(pageSource, /window\.setInterval/);
  assert.match(pageSource, /activityRefreshInFlightRef/);
  assert.match(pageSource, /Promise\.allSettled/);
  assert.doesNotMatch(pageSource, /localStorage.*session/i);
  assert.doesNotMatch(pageSource, /useAppStore/);
  assert.doesNotMatch(pageSource, /navigator\.clipboard|artifact\.path|file_name|raw_content/);
  assert.ok(
    capability.permissions.includes('core:event:allow-listen'),
    'the control window must be able to register its typed snapshot listener',
  );
  assert.ok(
    capability.permissions.includes('core:event:allow-unlisten'),
    'the control window must be able to release its typed snapshot listener',
  );
  assert.equal(
    capability.permissions.includes('core:event:default'),
    false,
    'the control window must not gain event emit authority',
  );
  assert.match(cssSource, /html\[data-window='login-browser-control'\]/);
  assert.match(cssSource, /prefers-reduced-motion/);
  assert.match(cssSource, /\.login-browser-recent-proof/);
  assert.match(cssSource, /\.login-browser-proof-kinds/);
  assert.match(pageSource, /className="login-browser-control-body"/);
  assert.match(
    pageSource,
    /login-browser-inline-error[\s\S]*login-browser-actions[\s\S]*<\/div>\s*<footer className="login-browser-control-footer">/,
  );
  assert.match(
    cssSource,
    /\.login-browser-control-body\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;/,
  );
  assert.match(
    cssSource,
    /\.login-browser-control-footer\s*\{[\s\S]*flex:\s*none;/,
  );
  assert.match(
    pageSource,
    /aria-label=\{t\('loginBrowserControl\.policyBoundary'\)\}/,
  );
  assert.match(pageSource, /loginBrowserControl\.downloadsBlocked/);
  assert.match(pageSource, /loginBrowserControl\.uploadsBlocked/);
  assert.equal(zh.loginBrowserControl.downloadsBlocked, '下载已阻止');
  assert.equal(zh.loginBrowserControl.uploadsBlocked, '上传已阻止 · 暂无授权选择器');
  assert.equal(en.loginBrowserControl.downloadsBlocked, 'Downloads blocked');
  assert.equal(en.loginBrowserControl.uploadsBlocked, 'Uploads blocked · no approved picker');
  assert.equal(zh.loginBrowserControl.recentProof, '最近证据');
  assert.equal(zh.loginBrowserControl.proofMetadataOnly, '只读不可变元数据');
  assert.equal(en.loginBrowserControl.recentProof, 'Recent proof');
  assert.equal(en.loginBrowserControl.proofMetadataOnly, 'Read-only immutable metadata');
});
