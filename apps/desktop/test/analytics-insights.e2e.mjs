// Real React + Recharts browser regression. IPC is deliberately controlled.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/analytics-insights.e2e.mjs
// Use PLAYWRIGHT_CHANNEL=chrome for an installed Chrome, or Playwright's default Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const desktop = path.resolve(import.meta.dirname, '..');
const output = path.join(desktop, '../../.artifacts/analytics-switch-recovery');
await fs.mkdir(output, { recursive: true });
await build({
  absWorkingDir: desktop,
  entryPoints: ['test/fixtures/analytics-insights.tsx'],
  outfile: path.join(output, 'fixture.js'), bundle: true, format: 'iife',
  platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.ANALYTICS_BUILD ?? 'production'), 'import.meta.env.VITE_PERF_MODE': 'undefined' },
  plugins: [{ name: 'controlled-ipc', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'ipc', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      contents: 'export const invoke = (...args) => window.__analyticsFixture.invoke(...args);', loader: 'js',
    }));
  } }],
});
const styles = (await fs.readdir(path.join(desktop, 'dist/assets')).catch(() => [])).filter((name) => name.endsWith('.css'));
const styleLinks = styles.map((name) => `<link rel="stylesheet" href="${pathToFileURL(path.join(desktop, 'dist/assets', name)).href}">`).join('');
await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html><head>${styleLinks}</head><body><div id="root" style="width:1000px;padding:24px"></div><script src="fixture.js"></script></body></html>`);
const modulePath = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
const browser = await playwright.chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const results = [];
async function hoverLatest(page, model) {
  const chart = page.locator('.recharts-wrapper').first();
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width - 10, box.y + 60);
  await page.waitForFunction((model) => {
    const tooltip = document.querySelector('.recharts-tooltip-wrapper');
    return tooltip && getComputedStyle(tooltip).visibility === 'visible' && tooltip.textContent.includes(model);
  }, model, { timeout: 3000 });
}
try {
  for (const mode of ['default', 'reduced']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${pathToFileURL(path.join(output, 'index.html')).href}?mode=${mode}`);
    await page.waitForFunction(() => window.__analyticsFixture.requests.length === 1);
    await page.locator('.recharts-area-curve').waitFor();
    for (const label of ['小时', '周', '月', '日']) {
      await page.getByRole('radio', { name: label, exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__analyticsFixture.selectionAfterClick),
        { label, selected: 'true' }, 'The clicked selection must commit with the input event, without waiting for a background render');
      await page.waitForFunction((label) => [...document.querySelectorAll('[role="radio"]')]
        .some((el) => el.textContent === label && el.getAttribute('aria-checked') === 'true'), label, { timeout: 3000 });
      const axisPattern = { '小时': ':00', '日': '月\\d+日', '周': '-W\\d+', '月': '年' }[label];
      await page.waitForFunction((pattern) => {
        const ticks = document.querySelector('.recharts-wrapper')?.querySelectorAll('.recharts-cartesian-axis-tick-value') ?? [];
        return new RegExp(pattern).test([...ticks].map((tick) => tick.textContent).join(' '));
      }, axisPattern, { timeout: 3000 });
    }
    await page.evaluate(() => {
      window.__analyticsFixture.mode = 'success';
      window.__analyticsFixture.requests.forEach((_, index) => window.__analyticsFixture.resolve(index));
    });
    await page.locator('.recharts-area-curve').waitFor();
    await page.waitForTimeout(500);
    await hoverLatest(page, 'fixture-model');
    await page.evaluate(() => window.__analyticsFixture.setBusy(true));
    await page.getByRole('radio', { name: '月', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="radio"]')]
      .some((el) => el.textContent === '月' && el.getAttribute('aria-checked') === 'true'), null, { timeout: 2000 });
    await hoverLatest(page, 'fixture-model');
    assert.match(await page.locator('.recharts-wrapper').first().textContent(), /年/);
    await page.evaluate(() => window.__analyticsFixture.setBusy(false));
    await page.getByRole('radio', { name: '日', exact: true }).click();
    await hoverLatest(page, 'fixture-model');
    // A failed breakdown keeps the total chart and all time buttons usable.
    await page.evaluate(() => {
      window.__analyticsFixture.mode = 'pending';
      window.__analyticsFixture.update('fixture:failure');
    });
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('正在加载'));
    await page.evaluate(() => window.__analyticsFixture.reject(window.__analyticsFixture.requests.length - 1));
    await page.getByRole('status').filter({ hasText: '模型明细加载失败' }).waitFor();
    await page.locator('.recharts-wrapper').first().waitFor();
    await page.screenshot({ path: path.join(output, `${mode}-failed.png`) });
    await page.evaluate(() => { window.__analyticsFixture.mode = 'success'; });
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await hoverLatest(page, 'fixture-model');
    assert.equal(await page.getByRole('status').count(), 0);
    // Refresh recovers details even if the parent stats timestamp is unchanged.
    const requestCount = await page.evaluate(() => window.__analyticsFixture.requests.length);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction((count) => window.__analyticsFixture.requests.length > count, requestCount);
    await hoverLatest(page, 'fixture-model');
    // Complete a newer request first, then the old one, and revisit its bucket.
    await page.evaluate(() => {
      window.__analyticsFixture.mode = 'pending';
      window.__analyticsFixture.update('fixture:old');
    });
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('正在加载'));
    const oldIndex = await page.evaluate(() => window.__analyticsFixture.requests.length - 1);
    await page.evaluate(() => window.__analyticsFixture.update('fixture:new'));
    await page.waitForFunction((index) => window.__analyticsFixture.requests.length > index + 1, oldIndex);
    await page.evaluate((index) => {
      window.__analyticsFixture.resolve(index + 1, 'new-model');
      window.__analyticsFixture.resolve(index, 'obsolete-model');
    }, oldIndex);
    await hoverLatest(page, 'new-model');
    await page.evaluate(() => { window.__analyticsFixture.mode = 'success'; });
    await page.getByRole('radio', { name: '小时', exact: true }).click();
    await hoverLatest(page, 'fixture-model');
    assert.match(await page.locator('.recharts-wrapper').first().textContent(), /:00/);
    const beforeReturn = await page.evaluate(() => window.__analyticsFixture.requests.length);
    await page.getByRole('radio', { name: '日', exact: true }).click();
    await hoverLatest(page, 'new-model');
    assert.equal(await page.evaluate(() => window.__analyticsFixture.requests.length), beforeReturn);
    assert.deepEqual(errors, []);
    results.push({ mode, switching: 'passed', modelTooltip: 'passed', polling: 'passed', retry: 'passed', refresh: 'passed', staleResponse: 'passed' });
    await page.screenshot({ path: path.join(output, `${mode}.png`) });
    await page.close();
  }
} catch (error) {
  results.push({ error: String(error.stack ?? error) });
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2));
  await browser.close();
  console.log(JSON.stringify(results, null, 2));
}
