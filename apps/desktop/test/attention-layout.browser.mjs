// Run with a Vite server and Playwright (Chromium/Chrome) available:
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/attention-layout.browser.mjs
// ATTENTION_BASE_URL defaults to http://127.0.0.1:19429. Artifacts stay untracked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = path.resolve(import.meta.dirname, '../../../.artifacts/attention-panel');
await fs.mkdir(artifacts, { recursive: true });
const baseline = process.argv.includes('--expect-overlap');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1120, height: 800 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const evidence = [];
const viewport = page.locator('.workspace-transcript-scroll [data-radix-scroll-area-viewport]');
const inline = page.locator('[data-composer-attention-layout="inline"]');
const overlay = page.locator('[data-composer-attention-layout="overlay"]');
const toggle = page.locator('[aria-controls^="plan-exit-body-"]');
async function scenario(name) {
  await page.locator(`[data-scenario="${name}"]`).click();
  await page.getByText('Transcript 第 40 行：常规 attention 应占据布局空间。', { exact: true }).waitFor();
  await page.waitForTimeout(250);
}
async function wheelTranscript() {
  const box = await viewport.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.wheel(0, -10000);
  await page.waitForTimeout(250);
  const top = await viewport.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, 10000);
  await page.waitForTimeout(250);
  const bottom = await viewport.evaluate((el) => el.scrollTop);
  assert.ok(bottom > top + 50, 'real wheel gesture must scroll the transcript');
  const last = await page.getByText('Transcript 第 40 行：常规 attention 应占据布局空间。', { exact: true }).boundingBox();
  assert.ok(last.y + last.height <= box.y + box.height + 1, 'last transcript line must be reachable');
  return { top, bottom, lastLineBottom: last.y + last.height };
}
try {
  await page.goto(`${process.env.ATTENTION_BASE_URL || 'http://127.0.0.1:19429'}/test/fixtures/attention-layout.html`);
  await scenario('regular');
  await page.getByText('一条排队中消息：检查 transcript 最后一行', { exact: true }).waitFor();
  const transcript = await viewport.boundingBox();
  const dock = await page.locator('.workspace-attention-dock').boundingBox();
  if (baseline) {
    assert.ok(dock.y < transcript.y + transcript.height - 50, 'baseline must reproduce transcript overlap');
    evidence.push({ scenario: 'baseline regular overlap', transcript, dock });
    await page.screenshot({ path: path.join(artifacts, 'baseline-overlap.png') });
  } else {
    assert.equal(await overlay.count(), 0);
    assert.equal(await inline.count(), 1);
    assert.ok(dock.y >= transcript.y + transcript.height, 'regular attention must be outside transcript bounds');
    evidence.push({ scenario: 'regular', transcript, dock, wheel: await wheelTranscript() });
    await page.screenshot({ path: path.join(artifacts, 'regular.png') });
    await scenario('none');
    const empty = await viewport.boundingBox();
    assert.ok(empty.height > transcript.height + 50, 'removing regular attention returns space to transcript');
    assert.equal(await page.locator('.workspace-attention-dock').count(), 0);
    for (const name of ['plan', 'mixed']) {
      await scenario(name);
      await toggle.waitFor();
      assert.equal(await overlay.count(), 1);
      assert.equal(await inline.count(), name === 'mixed' ? 1 : 0);
      const expanded = await overlay.boundingBox();
      const view = await viewport.boundingBox();
      assert.ok(expanded.y < view.y + view.height - 50, 'expanded Plan intentionally overlaps transcript');
      if (name === 'mixed') {
        const regular = await inline.boundingBox();
        assert.ok(regular.y >= view.y + view.height);
        assert.equal(await overlay.getByText('后台任务', { exact: true }).count(), 0);
        assert.equal(await inline.getByText('一条排队中消息：检查 transcript 最后一行', { exact: true }).count(), 1);
      }
      await page.screenshot({ path: path.join(artifacts, `${name}-expanded.png`) });
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('[id^="plan-exit-body-"]').isVisible(), false);
      const collapsed = await overlay.boundingBox();
      assert.ok(collapsed.height < expanded.height - 100);
      const viewCollapsed = await viewport.boundingBox();
      assert.equal(viewCollapsed.height, view.height, 'Plan collapse does not change normal-flow allocation');
      await overlay.getByRole('button', { name: '继续执行' }).waitFor();
      evidence.push({ scenario: name, expanded, collapsed, wheel: await wheelTranscript() });
      await page.screenshot({ path: path.join(artifacts, `${name}-collapsed.png`) });
      await toggle.focus();
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('[id^="plan-exit-body-"]').isVisible(), true);
    }
    await page.setViewportSize({ width: 640, height: 600 });
    await scenario('regular');
    const smallView = await viewport.boundingBox();
    const smallDock = await inline.boundingBox();
    assert.ok(smallDock.y >= smallView.y + smallView.height && smallView.height > 100);
    evidence.push({ scenario: 'narrow regular', transcript: smallView, dock: smallDock });
    await page.screenshot({ path: path.join(artifacts, 'regular-narrow.png') });
    await scenario('mixed');
    await toggle.waitFor();
    const narrowToggle = await toggle.boundingBox();
    assert.ok(narrowToggle.y >= 0, 'Plan collapse control must stay inside a short window');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.screenshot({ path: path.join(artifacts, 'mixed-narrow.png') });
    evidence.push({ scenario: 'narrow Plan toggle reachable', toggle: narrowToggle });
    await scenario('crowded');
    const crowdedView = await viewport.boundingBox();
    const crowdedDock = await inline.boundingBox();
    assert.ok(crowdedDock.y >= crowdedView.y + crowdedView.height && crowdedView.height > 100);
    const candidates = await inline.locator('div').all();
    let scrollable;
    for (const candidate of candidates) {
      if (await candidate.evaluate(el => getComputedStyle(el).overflowY === 'auto' && el.scrollHeight > el.clientHeight)) {
        scrollable = candidate;
        break;
      }
    }
    assert.ok(scrollable, 'large regular panel needs an internal scroll region');
    const scrollBox = await scrollable.boundingBox();
    await page.mouse.move(scrollBox.x + 30, scrollBox.y + 30);
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(250);
    const panelScroll = await scrollable.evaluate(el => el.scrollTop);
    assert.ok(panelScroll > 0, 'large regular panel must scroll internally');
    evidence.push({ scenario: 'crowded regular', transcript: crowdedView, dock: crowdedDock, panelScroll });
    const writes = await page.evaluate(() => window.attentionFixture.calls.filter(({ command }) => /^(send_|respond_|enqueue_|set_|save_|update_)/.test(command)));
    assert.deepEqual(writes, [], 'collapse/expand must never send or approve a runtime request');
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, baseline ? 'baseline-behavior.json' : 'browser-behavior.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, baseline, evidence }, null, 2));
} finally {
  await browser.close();
}
