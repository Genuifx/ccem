// CCEM_TAURI_DEV_MANIFEST=<owned launcher's .json> node test/project-tree-collapse.mcp.e2e.mjs
// Uses synthetic sessions in the real system WebView. Never starts/stops an app
// or scans ports. Restores the original page after testing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { buildProjectTreeCollapseFixture } from './helpers/build-project-tree-collapse.mjs';

assert.ok(process.env.CCEM_TAURI_DEV_MANIFEST, 'Pass the manifest of your owned pnpm tauri:dev instance');
const manifest = JSON.parse(await fs.readFile(process.env.CCEM_TAURI_DEV_MANIFEST, 'utf8'));
assert.equal(manifest.status, 'running');
assert.ok(manifest.identifier.startsWith('com.ccem.desktop.dev.'));
process.kill(manifest.launcherPid, 0);
const artifacts = path.resolve(process.env.CCEM_TEST_ARTIFACT_DIR
  || path.join(manifest.worktreeRoot, '.artifacts/project-tree-collapse-native'));
await fs.mkdir(artifacts, { recursive: true });
await buildProjectTreeCollapseFixture();

const ws = new WebSocket(`ws://127.0.0.1:${manifest.mcpPort}`);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Owned bridge did not connect')), 5000);
  ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  ws.addEventListener('error', (event) => { clearTimeout(timer); reject(event.error); }, { once: true });
});
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', ({ data }) => {
  const response = JSON.parse(String(data));
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  clearTimeout(request.timer);
  if (response.success) request.resolve(response.data);
  else request.reject(new Error(response.error || 'Bridge command failed'));
});
ws.addEventListener('close', () => {
  for (const { timer, reject } of pending.values()) {
    clearTimeout(timer);
    reject(new Error('Owned bridge disconnected'));
  }
  pending.clear();
});
function call(command, args) {
  const id = `tree-collapse-${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${command} timed out`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, command, args }));
  });
}
const js = (script) => call('execute_js', { script });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(script) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await js(script)) return;
    await delay(100);
  }
  throw new Error(`Condition timed out: ${script}`);
}
async function click(selector) {
  assert.equal(await js(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`), true, `Missing control: ${selector}`);
  if (selector === collapse || selector === expand) {
    const nextControl = selector === collapse ? expand : collapse;
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(nextControl)}))`);
  } else {
    await delay(100);
  }
}
const collapse = 'button[aria-label="收起侧边栏"]';
const expand = 'button[aria-label="展开侧边栏"]';
const originalUrl = await js('location.href');
assert.equal(new URL(originalUrl).origin, new URL(manifest.tauriConfig.build.devUrl).origin);
const storageKeys = [
  'ccem-workspace-pinned-sessions', 'ccem-workspace-project-order',
  'ccem-workspace-project-classification', 'ccem-workspace-project-tree-sort',
  'ccem-locale', 'ccem-settings',
];
const originalStorage = await js(`Object.fromEntries(${JSON.stringify(storageKeys)}
  .map((key) => [key, localStorage.getItem(key)]))`);
const results = [];
try {
  await js(`${JSON.stringify(storageKeys)}.forEach((key) => localStorage.removeItem(key))`);
  for (const initiallyCollapsed of [true, false]) {
    const url = new URL('/test/fixtures/project-tree-collapse.html', originalUrl);
    if (initiallyCollapsed) url.searchParams.set('collapsed', '');
    await js(`location.assign(${JSON.stringify(url.href)})`);
    const initialControl = initiallyCollapsed ? expand : collapse;
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(initialControl)}))`);
    if (initiallyCollapsed) await click(expand);
    const width = await js('innerWidth');
    assert.ok(width >= 600 && await js('innerHeight') >= 500, 'Use a window at least 600 × 500');
    for (let cycle = 0; cycle < 4; cycle++) {
      if (cycle > 0) {
        await click(collapse);
        await click(expand);
      }
      await delay(350);
      // Do not inspect row bounds/styles or hit-test before capturing. Those
      // reads flush WebKit's stale skipped layout and can hide this regression.
      const dataUrl = await call('capture_native_screenshot', { format: 'png' });
      assert.equal(typeof dataUrl, 'string');
      const png = Buffer.from(dataUrl.split(',')[1], 'base64');
      const name = `${initiallyCollapsed ? 'collapsed' : 'expanded'}-${cycle}`;
      await fs.writeFile(path.join(artifacts, `${name}.png`), png);
      const metadata = await sharp(png).metadata();
      const scale = metadata.width / width;
      // Only the fixture's first project and conversation rows occupy this
      // rectangle. Header, footer and selected-session output are outside it.
      const pixels = await sharp(png).extract({
        left: Math.round(30 * scale), top: Math.round(155 * scale),
        width: Math.round(240 * scale), height: Math.round(180 * scale),
      }).removeAlpha().greyscale().raw().toBuffer();
      const ink = pixels.reduce((count, value) => count + (value < 150 ? 1 : 0), 0);
      results.push({ name, inkPixels: ink });
      assert.ok(ink > 100 * scale * scale, `${name}: project tree is blank before any layout inspection (${ink} ink pixels)`);
    }
    await click('[data-workspace-session-key="claude:collapse-0"]');
    assert.equal(await js('document.querySelector("output").textContent'), 'claude:collapse-0');
    await click('button[aria-label="按时间排序"]');
    await click(collapse);
    await click(expand);
    await click('[data-workspace-session-key="claude:collapse-1"]');
    assert.equal(await js('document.querySelector("output").textContent'), 'claude:collapse-1');
    await click('button[aria-label="按项目分组"]');
  }
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} finally {
  await fs.writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
  try {
    await js(`Object.entries(${JSON.stringify(originalStorage)}).forEach(([key, value]) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    })`);
    await js(`location.assign(${JSON.stringify(originalUrl)})`);
  } finally {
    for (const { timer } of pending.values()) clearTimeout(timer);
    ws.close();
  }
}
