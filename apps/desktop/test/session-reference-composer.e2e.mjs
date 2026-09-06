// Run against a Vite dev server: CCEM_TEST_URL=http://127.0.0.1:PORT node test/session-reference-composer.e2e.mjs
// Set PLAYWRIGHT_MODULE when using the desktop app's bundled test runtime.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.CCEM_TEST_BROWSER_CHANNEL });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const url = `${process.env.CCEM_TEST_URL || 'http://127.0.0.1:18369'}/test/fixtures/session-reference-composer.html`;
const state = () => page.evaluate(() => window.sessionReferenceFixture);
const editor = () => page.locator('[contenteditable="true"]');
async function fresh() { await page.goto(url); await editor().waitFor(); }
async function selectReference() {
  await editor().pressSequentially('@');
  await page.getByRole('option', { name: /@设计方案/ }).click();
  await page.locator('[data-session-reference-strip]').waitFor();
}
const results = [];
try {
  await fresh();
  await selectReference();
  assert.equal((await state()).reads.length, 0);
  assert.equal((await state()).handoffs.length, 0);
  await page.locator('[data-restore-draft]').click();
  await page.locator('[data-session-reference-strip]').waitFor();
  assert.match(await page.locator('[data-persisted-draft]').textContent(), /ccem-session:native-design/);
  await editor().click(); await editor().press('End'); await editor().pressSequentially(' 请参考这份方案');
  await page.getByRole('button', { name: '发送当前消息', exact: true }).click();
  await page.waitForFunction(() => window.sessionReferenceFixture.submissions.length === 1);
  let s = await state();
  assert.equal(s.handoffs.length, 0); assert.equal(s.reads.length, 1);
  assert.match(s.submissions[0].text, /引用不应该发送消息/);
  assert.equal((await editor().textContent()).trim(), '');
  results.push('reference selection/restored draft/current submit: no target send');

  await fresh(); await selectReference();
  await page.evaluate(() => { window.sessionReferenceFixture.emptyText = true; });
  await editor().click(); await editor().press('End');
  await editor().pressSequentially(' 帮我给他发个消息：请检查失败路径');
  await page.getByRole('button', { name: '发送当前消息', exact: true }).click();
  await page.waitForFunction(() => window.sessionReferenceFixture.submissions.length === 1);
  s = await state();
  assert.match(s.submissions[0].text, /帮我给他发个消息：请检查失败路径/);
  assert.match(s.submissions[0].text, /mcp__ccem-sessions__send_message/);
  assert.match(s.submissions[0].text, /"text_available":false/);
  assert.match(s.submissions[0].text, /native-design/);
  assert.equal(s.handoffs.length, 0, 'Composer must delegate intent to the current model, not send by keyword');
  assert.equal(await page.locator('[data-session-reference-panel]').count(), 0);
  results.push('natural-language send request reaches current model with target identity and no extra dialog');

  await fresh(); await selectReference();
  await editor().evaluate((element) => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'fixture.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await page.getByRole('button', { name: '移除附件', exact: true }).click();
  await page.locator('[data-restore-draft]').click();
  await page.locator('[data-session-reference-strip]').waitFor();
  assert.match(await page.locator('[data-persisted-draft]').textContent(), /ccem-session:native-design/);
  await page.getByRole('button', { name: '发送当前消息', exact: true }).click();
  await page.waitForFunction(() => window.sessionReferenceFixture.submissions.length === 1);
  assert.match((await state()).submissions[0].text, /引用不应该发送消息/);
  assert.equal((await state()).handoffs.length, 0);
  results.push('image paste/removal/remount preserves session identity and reference submit');

  await fresh(); await selectReference();
  await page.locator('[data-session-reference-strip] button').click();
  await page.locator('[data-session-reference-preview]').getByText(/默认参考上下文/).waitFor();
  assert.equal((await state()).handoffs.length, 0);
  await page.getByRole('button', { name: '发送给该会话…', exact: true }).click();
  await page.getByRole('textbox', { name: '交接内容' }).fill('请检查方案中的失败路径');
  await page.getByRole('button', { name: '确认提交给该会话', exact: true }).dblclick();
  await page.waitForFunction(() => window.sessionReferenceFixture.handoffs.length === 1);
  s = await state(); assert.equal(s.submissions.length, 0);
  assert.equal(s.handoffs[0].targetRuntimeId, 'native-design');
  assert.equal(s.handoffs[0].sourceRuntimeId, 'native-current');
  assert.match(await page.locator('[data-persisted-draft]').textContent(), /ccem-session/);
  results.push('preview reads only; explicit confirmation sends once and preserves draft');

  await fresh(); await selectReference();
  await page.evaluate(() => { window.sessionReferenceFixture.readDelay = 350; });
  await page.getByRole('button', { name: '发送当前消息', exact: true }).click();
  await editor().click(); await editor().press('End'); await editor().pressSequentially(' 后续草稿');
  await page.waitForFunction(() => window.sessionReferenceFixture.submissions.length === 1);
  assert.doesNotMatch((await state()).submissions[0].text, /后续草稿/);
  assert.match(await editor().textContent(), /后续草稿/);
  assert.equal((await state()).handoffs.length, 0);
  results.push('delayed reference read submits captured text and preserves newer edits');

  await fresh(); await selectReference();
  await page.evaluate(() => { window.sessionReferenceFixture.failRead = true; });
  await page.getByRole('button', { name: '发送当前消息', exact: true }).click();
  await page.getByText('无法读取引用会话，草稿已保留。请移除引用或稍后再试。').waitFor();
  assert.equal((await state()).submissions.length, 0);
  assert.match(await page.locator('[data-persisted-draft]').textContent(), /ccem-session/);
  results.push('unavailable reference preserves draft and blocks submit');

  await fresh(); await selectReference();
  await page.evaluate(() => { window.sessionReferenceFixture.failSend = true; });
  await page.locator('[data-session-reference-strip] button').click();
  await page.getByRole('button', { name: '发送给该会话…', exact: true }).click();
  await page.getByRole('textbox', { name: '交接内容' }).fill('please review');
  await page.getByRole('button', { name: '确认提交给该会话', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '提交未确认' }).waitFor();
  assert.equal((await state()).handoffs.length, 1);
  assert.equal(await page.getByRole('button', { name: '确认提交给该会话', exact: true }).count(), 0);
  results.push('uncertain handoff has no automatic or immediate retry');

  await fresh(); await page.evaluate(() => { window.sessionReferenceFixture.canSend = false; });
  await selectReference(); await page.locator('[data-session-reference-strip] button').click();
  await page.locator('[data-session-reference-preview]').getByText(/默认参考上下文/).waitFor();
  assert.equal(await page.getByRole('button', { name: '发送给该会话…', exact: true }).count(), 0);
  results.push('offline/quarantined target can be referenced but cannot be sent to');

  await fresh(); await editor().pressSequentially('@');
  await page.getByRole('option', { name: /README.md/ }).click();
  await page.getByRole('button', { name: '发送当前消息', exact: true }).click();
  await page.waitForFunction(() => window.sessionReferenceFixture.submissions.length === 1);
  assert.equal((await state()).reads.length, 0); assert.equal((await state()).handoffs.length, 0);
  results.push('file mention retains original send path without session reads');

  await fresh(); await selectReference();
  await page.locator('[data-session-reference-strip] button').click();
  await page.locator('[data-session-reference-preview]').getByText(/默认参考上下文/).waitFor();
  if (process.env.CCEM_TEST_ARTIFACTS) {
    await fs.mkdir(process.env.CCEM_TEST_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: `${process.env.CCEM_TEST_ARTIFACTS}/reference-preview.png` });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: results.length, results, pageErrors: errors }, null, 2));
} finally { await browser.close(); }
