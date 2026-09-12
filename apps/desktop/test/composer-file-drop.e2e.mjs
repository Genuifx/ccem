// Real Composer browser smoke; native events are injected via Tauri's event API.
// This does not prove Finder-to-WebView delivery. Run against a Vite dev server.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = process.env.CCEM_TEST_URL || 'http://127.0.0.1:18379';
const artifactDir = process.env.CCEM_TEST_ARTIFACT_DIR || '../../.artifacts/composer-file-drop';
const results = [];
const paths = ['/fixture/project/你好 world.md', '/tmp/outside spec.pdf', '/fixture/project/你好 world.md'];
const card = page.locator('[data-composer-shell-card]');
const chips = page.locator('[data-composer-attachment-chip]');
const editor = page.locator('[contenteditable="true"]');
async function emit(type, inside = true, droppedPaths = paths) {
  const box = await card.boundingBox();
  await page.evaluate(async ({ type, inside, paths, box }) => {
    const { emit } = await import('/node_modules/@tauri-apps/api/event.js');
    const scale = window.devicePixelRatio;
    await emit(`tauri://drag-${type}`, type === 'leave' ? {} : {
      paths, position: { x: (box.x + box.width / 2) * scale, y: (inside ? box.y + box.height / 2 : box.y - 20) * scale },
    });
  }, { type, inside, paths: droppedPaths, box });
}
try {
  await page.goto(`${base}/test/fixtures/session-reference-composer.html`);
  await editor.waitFor();
  await editor.pressSequentially('draft before drop');
  await emit('enter', false);
  assert.equal(await card.getAttribute('data-composer-drop-active'), null);
  await emit('over');
  await page.locator('[data-composer-drop-active="true"]').waitFor();
  await emit('leave');
  await page.waitForFunction(() => !document.querySelector('[data-composer-drop-active]'));
  await emit('drop', false);
  assert.equal(await chips.count(), 0);
  await emit('drop');
  await page.waitForFunction(() => document.querySelectorAll('[data-composer-attachment-chip]').length === 2);
  assert.equal(await editor.evaluate((e) => document.activeElement === e), true);
  await emit('drop');
  assert.equal(await chips.count(), 2);
  assert.match(await editor.textContent(), /draft before drop/);
  assert.equal(await chips.filter({ hasText: '你好 world.md' }).getAttribute('title'), paths[0]);
  results.push('Retina enter/over/leave/drop: outside ignored, inside highlighted, paths deduplicated, editor focused');
  await chips.filter({ hasText: 'outside spec.pdf' }).getByRole('button', { name: '移除附件', exact: true }).click();
  assert.equal(await chips.count(), 1);
  await editor.click(); await editor.press('End'); await editor.pressSequentially(' @README');
  await page.getByRole('option', { name: /README.md/ }).click();
  await editor.evaluate((element) => {
    const data = new DataTransfer(); data.setData('text/plain', ' pasted after file');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.match(await editor.textContent(), /README.md/);
  assert.match(await editor.textContent(), /pasted after file/);
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: `${artifactDir}/references.png`, fullPage: true });
  await page.getByRole('button', { name: '发送当前消息', exact: true }).click();
  await page.waitForFunction(() => window.sessionReferenceFixture.submissions.length === 1);
  const submission = await page.evaluate(() => window.sessionReferenceFixture.submissions[0]);
  assert.equal(submission.attachments.length, 1);
  assert.equal(submission.attachments[0].absolutePath, paths[0]);
  assert.equal(submission.attachments[0].relativePath, '你好 world.md');
  assert.match(submission.text, /README.md/);
  assert.match(submission.text, /pasted after file/);
  assert.equal(await chips.count(), 0);
  results.push('remove external file, select @README, paste text, submit: correct payload and cleared attachments');
  await emit('drop', true, ['/tmp/attachment-only.txt']);
  await page.getByRole('button', { name: '发送当前消息', exact: true }).click();
  await page.waitForFunction(() => window.sessionReferenceFixture.submissions.length === 2);
  results.push('attachment-only draft submits without requiring text');
  assert.deepEqual(errors, []);
  await fs.writeFile(`${artifactDir}/browser-behavior.json`, JSON.stringify({ results, errors, nativeEvents: 'injected through Tauri event API', submissions: 2 }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally { await browser.close(); }
