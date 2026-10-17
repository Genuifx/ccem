// Requires the canonical tauri:dev Vite URL and a Playwright installation.
// PLAN_CONTENT_BASE_URL=http://127.0.0.1:<vite-port> PLAYWRIGHT_MODULE=<path> node test/plan-content.browser.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = path.resolve(import.meta.dirname, '../../../.artifacts/plan-exit-content');
const server = spawn(process.execPath, [path.join(import.meta.dirname, 'plan-content-smoke-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
try {
  const info = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Plan fixture server startup timed out')), 15000);
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited: ${code}`)); });
    server.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0])); }
    });
  });
  const endpoint = `http://127.0.0.1:${info.port}`;
  const state = () => fetch(endpoint).then(res => res.json());
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1024, height: 740 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.env.PLAN_CONTENT_BASE_URL}/test/fixtures/plan-content.html?port=${info.port}`);
  const body = page.locator('[id^="plan-exit-body-"]');
  const toggle = page.locator('[aria-controls^="plan-exit-body-"]');
  const panel = page.locator('[data-composer-attention-layout="overlay"] .overflow-y-auto');
  await body.getByText('END_OF_COMPLETE_PLAN', { exact: false }).waitFor();
  assert.equal(await body.locator('h2').count(), 60);
  assert.equal(await body.locator('li').count(), 60);
  const content = await body.textContent();
  await page.screenshot({ path: path.join(artifacts, 'browser-plan-expanded.png') });
  const box = await panel.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 10000);
  await page.waitForFunction(() => { const p = document.querySelector('[data-composer-attention-layout="overlay"] .overflow-y-auto'); return p.scrollTop > 0 && p.scrollTop >= p.scrollHeight - p.clientHeight - 2; });
  const end = await body.getByText('END_OF_COMPLETE_PLAN', { exact: false }).boundingBox();
  assert.ok(end.y >= box.y && end.y + end.height <= box.y + box.height);
  await page.screenshot({ path: path.join(artifacts, 'browser-plan-end.png') });
  await page.mouse.wheel(0, -10000);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await body.isVisible(), false);
  assert.equal((await state()).calls.filter(c => c.command === 'respond_native_session_prompt').length, 0);
  await page.screenshot({ path: path.join(artifacts, 'browser-plan-collapsed.png') });
  await toggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await body.textContent(), content);
  await page.reload();
  await body.getByText('END_OF_COMPLETE_PLAN', { exact: false }).waitFor();
  assert.equal(await body.textContent(), content);
  await page.getByRole('button', { name: '继续执行', exact: true }).click();
  await page.getByText('PLAN_FIXTURE_APPROVED', { exact: true }).waitFor();
  assert.equal(await toggle.count(), 0);
  const final = await state();
  const replies = final.calls.filter(c => c.command === 'respond_native_session_prompt');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].args.answers.decision, 'approve');
  assert.ok(final.events.some(e => e.payload.type === 'interactive_response_result' && e.payload.state === 'applied'));
  assert.ok(final.events.some(e => e.payload.text === 'PLAN_FIXTURE_APPROVED'));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(artifacts, 'browser-plan-approved.png') });
  const evidence = { passed: true, sections: 60, fullContentLength: content.length, scrollToEnd: true, collapseDoesNotApprove: true, keyboardExpand: true, reloadPreservesContent: true, approvalRequests: 1, helperReceipt: 'applied', helperContinued: true, errors };
  await fs.writeFile(path.join(artifacts, 'browser-behavior.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
