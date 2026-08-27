import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const desktopDir = path.resolve(import.meta.dirname, '..');

test('browser backend avoids Wry webview.url because it can panic on empty WKWebView URLs', async () => {
  const browserDir = path.join(desktopDir, 'src-tauri', 'src', 'browser');
  const [browserSource, registrySource, webviewSource] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src-tauri', 'src', 'browser.rs'), 'utf8'),
    fs.readFile(path.join(browserDir, 'registry.rs'), 'utf8'),
    fs.readFile(path.join(browserDir, 'webview.rs'), 'utf8'),
  ]);
  const moduleSource = `${browserSource}\n${registrySource}\n${webviewSource}`;

  assert.doesNotMatch(moduleSource, /\.url\(\)/);
  assert.doesNotMatch(moduleSource, /\.on_page_load\(/);
  assert.match(webviewSource, /fn browser_page_metadata\(webview: &tauri::Webview\)/);
  assert.match(webviewSource, /\.URL\(\)[\s\S]*\.and_then\(\|url\| url\.absoluteString\(\)\)/);
  assert.match(webviewSource, /\.on_document_title_changed\(/);
  assert.match(webviewSource, /\.incognito\(true\)/);
  assert.doesNotMatch(webviewSource, /data_store_identifier/);
  assert.match(registrySource, /current_url: Option<String>/);
  assert.match(registrySource, /apply_navigation_metadata/);

  const infoMethod = browserSource.match(
    /pub fn info\([\s\S]*?\r?\n    }\r?\n\r?\n    pub fn health_check/,
  )?.[0] ?? '';
  assert.match(infoMethod, /session_snapshot/);
  assert.doesNotMatch(infoMethod, /browser_page_metadata|\.URL\(\)/);
  assert.match(
    browserSource,
    /fn session_snapshot[\s\S]*?self\.registry[\s\S]*?snapshot_or_create/,
  );
});
