// Start an owned Vite server, then run with COMPOSER_SCROLL_BASE_URL and an
// existing PLAYWRIGHT_MODULE. Uses real wheel/keyboard/clicks, never force-click
// or programmatic scrolling. Screenshots and JSON remain under .artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
const artifacts = path.resolve(process.env.COMPOSER_SCROLL_OUTPUT_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../.artifacts/composer-scroll'));
await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', chromiumSandbox: true });
const context = await browser.newContext({ reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const evidence = [];
const failures = [];
const dock = page.locator('[data-attention-state] > div');

async function wheelAt(locator, delta) {
  const box = await locator.boundingBox();
  const bounds = await dock.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && bounds && viewport);
  // Nested panels can be partly outside the dock after the selected suggestion
  // scrolls into view. A wheel only reaches the panel inside the visible overlap.
  const left = Math.max(box.x, bounds.x, 0);
  const top = Math.max(box.y, bounds.y, 0);
  const right = Math.min(box.x + box.width, bounds.x + bounds.width, viewport.width);
  const bottom = Math.min(box.y + box.height, bounds.y + bounds.height, viewport.height);
  assert.ok(right > left && bottom > top, 'wheel target must intersect the visible dock');
  const point = { x: left + Math.min(20, (right - left) / 2), y: top + Math.min(20, (bottom - top) / 2) };
  assert.ok(await locator.evaluate((el, { x, y }) => el.contains(document.elementFromPoint(x, y)), point), 'wheel target must be reachable');
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(150); // Allow the browser's asynchronous wheel dispatch.
}
async function wheelOuter(delta) {
  const box = await dock.boundingBox();
  // The dock's right edge is outside nested panels' scrollbars and padding.
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(150);
}
async function reachable(locator) {
  const result = await locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { visible: Boolean(hit && el.contains(hit)), x, y, height: r.height };
  });
  assert.equal(result.visible, true, `button must be reachable before Playwright can auto-scroll it: ${JSON.stringify(result)}`);
  return result;
}
async function wheelOuterTo(locator) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const box = await locator.boundingBox();
    const bounds = await dock.boundingBox();
    const delta = box.y + box.height / 2 - (bounds.y + bounds.height / 2);
    await wheelOuter(delta);
  }
  return reachable(locator);
}

try {
  for (const size of [{ width: 1120, height: 800 }, { width: 640, height: 480 }]) {
    await page.setViewportSize(size);
    for (const name of ['trigger', 'question', 'queue', 'trigger-queue', 'question-queue', 'all']) {
      const label = `${name}-${size.width}x${size.height}`;
      try {
        await page.goto(`${process.env.COMPOSER_SCROLL_BASE_URL || 'http://127.0.0.1:19429'}/test/fixtures/composer-scroll.html`);
        await page.locator(`[data-scenario="${name}"]`).click();
        if (name.includes('trigger') || name === 'all') {
          const editor = page.getByRole('textbox');
          await editor.click();
          await editor.pressSequentially('@file');
          await page.getByRole('option').last().waitFor();
        }
        await dock.waitFor();
        const before = await dock.evaluate(el => ({ overflow: getComputedStyle(el).overflowY, height: el.clientHeight, scrollHeight: el.scrollHeight }));
        if (name === 'trigger') {
          assert.equal(before.overflow, 'hidden', 'a lone suggestion list must not add an outer scrollbar');
          const viewport = dock.locator('[data-radix-scroll-area-viewport]');
          await wheelAt(viewport, 10000);
          assert.ok(await viewport.evaluate(el => el.scrollTop) > 0, 'real wheel must scroll suggestions');
          const last = page.getByRole('option').last();
          await reachable(last);
          await last.click();
          assert.match(await page.getByRole('textbox').textContent(), /file-07/);
          assert.equal(await page.getByRole('listbox').count(), 0, 'selecting a suggestion closes the list');
        } else {
          if (name.includes('question') || name === 'all') {
            // Typing a trigger can reveal the selected suggestion below the
            // question. Return to the question before scrolling its contents.
            await wheelOuter(-10000);
            const question = page.locator('[data-scroll-question]').locator('..');
            await wheelAt(question, 10000);
            const answer = page.getByRole('button', { name: 'Submit answer', exact: true });
            await wheelOuterTo(answer);
            await answer.click();
            assert.equal(await page.evaluate(() => window.composerScrollFixture.answers), 1);
          }
          if (name.includes('queue') || name === 'all') {
            await wheelOuter(10000);
            const queue = page.locator('[data-ccem-composer-queue]').locator('../..');
            await wheelAt(queue, 10000);
            const remove = page.locator('[data-ccem-composer-queued-message="queue-2"] button');
            await wheelOuterTo(remove);
            await remove.click();
            assert.deepEqual(await page.evaluate(() => window.composerScrollFixture.removed), ['queue-2']);
          }
        }
        await page.screenshot({ path: path.join(artifacts, `${label}.png`) });
        evidence.push({ scenario: name, viewport: size, before, passed: true });
      } catch (error) {
        failures.push({ scenario: name, viewport: size, error: String(error) });
        await page.screenshot({ path: path.join(artifacts, `${label}-failed.png`) });
      }
    }
  }
  assert.deepEqual(errors, [], 'fixture must not produce unhandled browser errors');
} finally {
  await fs.writeFile(path.join(artifacts, 'behavior.json'), JSON.stringify({ evidence, failures, errors }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ evidence, failures, errors }, null, 2));
assert.deepEqual(failures, [], 'all real-browser scroll and action scenarios must pass');
