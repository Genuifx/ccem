// Run against the Vite URL printed by your owned `pnpm tauri:dev` launcher:
// CCEM_TEST_URL=http://127.0.0.1:<port> PLAYWRIGHT_MODULE=<path> node test/project-tree-collapse.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildProjectTreeCollapseFixture } from './helpers/build-project-tree-collapse.mjs';

await buildProjectTreeCollapseFixture();
const require = createRequire(import.meta.url);
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert.ok(process.env.CCEM_TEST_URL, 'CCEM_TEST_URL must identify your owned Vite server');
const engine = process.env.CCEM_TEST_BROWSER || 'webkit';
const artifactDir = path.resolve(process.env.CCEM_TEST_ARTIFACT_DIR || '../../.artifacts/project-tree-collapse');
await fs.mkdir(artifactDir, { recursive: true });
const browser = await playwright[engine].launch({
  headless: true,
  ...(process.env.CCEM_TEST_EXECUTABLE ? { executablePath: process.env.CCEM_TEST_EXECUTABLE } : {}),
});
const results = [];
try {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    for (const initiallyCollapsed of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, reducedMotion });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const caseName = `${engine}-${reducedMotion}-${initiallyCollapsed ? 'collapsed' : 'expanded'}`;
      const capture = async (stage) => {
        const state = await page.locator('[data-radix-scroll-area-viewport]').evaluateAll((elements) => elements.map((element) => ({
          bounds: element.getBoundingClientRect().toJSON(),
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollTop: element.scrollTop,
          projects: [...element.querySelectorAll('[data-project-motion-key]')].map((row) => ({
            key: row.dataset.projectMotionKey,
            bounds: row.getBoundingClientRect().toJSON(),
            opacity: getComputedStyle(row).opacity,
            visibility: getComputedStyle(row).visibility,
          })),
        })));
        await fs.writeFile(path.join(artifactDir, `${caseName}-${stage}.json`), JSON.stringify({ state, errors }, null, 2));
        await page.screenshot({ path: path.join(artifactDir, `${caseName}-${stage}.png`) });
      };
      const project = page.getByRole('button', { name: 'Project 0', exact: true });
      const row = page.locator('[data-workspace-session-key="claude:collapse-0"]');
      const assertProjectPainted = async () => {
        await project.waitFor({ state: 'visible' });
        assert.equal(await project.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return Boolean(hit && element.contains(hit));
        }), true, 'Project header must be inside the viewport and hit-testable');
      };
      try {
        await page.goto(`${process.env.CCEM_TEST_URL}/test/fixtures/project-tree-collapse.html${initiallyCollapsed ? '?collapsed' : ''}`);
        if (initiallyCollapsed) await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
        await assertProjectPainted();
        await project.click();
        // Project 0 may already be expanded by the default most-recent selection.
        if (await project.getAttribute('aria-expanded') === 'false') await project.click();
        await row.click();
        assert.equal(await page.getByTestId('selection').textContent(), 'claude:collapse-0');
        await capture('before');
        for (let cycle = 0; cycle < 5; cycle++) {
          await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
          assert.equal(await page.locator('[data-radix-scroll-area-viewport]').count(), 0);
          await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
          await assertProjectPainted();
          assert.equal(await project.getAttribute('aria-expanded'), 'true', 'Expanded projects survive sidebar collapse');
          await row.click();
          assert.equal(await page.getByTestId('selection').textContent(), 'claude:collapse-0');
        }
        await page.getByRole('button', { name: '按时间排序', exact: true }).click();
        await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
        await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
        await row.click();
        assert.equal(await page.getByTestId('selection').textContent(), 'claude:collapse-0');
        await page.getByRole('button', { name: '按项目分组', exact: true }).click();
        await assertProjectPainted();
        const lastProject = page.getByRole('button', { name: 'Project 4', exact: true });
        if (await lastProject.getAttribute('aria-expanded') === 'false') await lastProject.click();
        await page.locator('[data-workspace-session-key="claude:collapse-32"]').click();
        assert.equal(await page.getByTestId('selection').textContent(), 'claude:collapse-32');
        assert.ok(await page.locator('[data-radix-scroll-area-viewport]').evaluate((element) => element.scrollTop) > 0,
          'Lower projects remain scrollable and selectable after reopening');
        assert.deepEqual(errors, []);
        await capture('after');
        results.push({ caseName, cycles: 5, status: 'passed' });
      } catch (error) {
        await capture('failed');
        throw error;
      } finally {
        await page.close();
      }
    }
  }
  await fs.writeFile(path.join(artifactDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
