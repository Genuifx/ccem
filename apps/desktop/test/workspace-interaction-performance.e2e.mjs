// Builds must already exist. This runner never launches a dev app or a server.
// PERF_BASE_URL=http://127.0.0.1:<owned-vite-port> node test/workspace-interaction-performance.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installEditorStyleMutationProbe } from './helpers/workspace-input-style-probe.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(desktop, '../..');
if (process.argv.includes('--help')) {
  console.log(`Usage: PERF_BASE_URL=http://127.0.0.1:<port> node test/workspace-interaction-performance.e2e.mjs [--bench | --behavior] [--variant baseline|current]
Environment: PLAYWRIGHT_MODULE, PERF_BROWSER=chromium|webkit|firefox,
PERF_EXECUTABLE_PATH, PERF_OUTPUT_DIR, PERF_ROUNDS=3, PERF_WIDTH=900,
PERF_HEIGHT=700, PERF_HEADLESS=1. Default runs benchmarks and behavior on both builds.
Results use synthetic IPC and real browser input. Two-rAF timings are presentation proxies.`);
  process.exit(0);
}
assert.ok(process.env.PERF_BASE_URL, 'PERF_BASE_URL must point at your already-running fixture server');
const baseUrl = new URL(process.env.PERF_BASE_URL);
const outputDir = path.resolve(process.env.PERF_OUTPUT_DIR ?? path.join(repository, '.artifacts/interaction-performance'));
await fs.mkdir(outputDir, { recursive: true });
const moduleSpecifier = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const imported = await import(path.isAbsolute(moduleSpecifier) ? pathToFileURL(moduleSpecifier).href : moduleSpecifier);
const playwright = imported.chromium ? imported : imported.default;
const engine = process.env.PERF_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit', 'firefox'].includes(engine), `Unsupported PERF_BROWSER=${engine}`);
const rounds = Number(process.env.PERF_ROUNDS ?? 3);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 20, 'PERF_ROUNDS must be 1..20');
const viewportSize = { width: Number(process.env.PERF_WIDTH ?? 900), height: Number(process.env.PERF_HEIGHT ?? 700) };
const variantIndex = process.argv.indexOf('--variant');
const variants = variantIndex < 0 ? ['baseline', 'current'] : [process.argv[variantIndex + 1]];
assert.ok(variants.every((value) => ['baseline', 'current'].includes(value)), 'Invalid --variant');
const runBenchmarks = !process.argv.includes('--behavior') || process.argv.includes('--bench');
const runBehaviors = !process.argv.includes('--bench') || process.argv.includes('--behavior');
const headless = process.env.PERF_HEADLESS !== '0';
const browser = await playwright[engine].launch({ headless,
  ...(process.env.PERF_EXECUTABLE_PATH ? { executablePath: process.env.PERF_EXECUTABLE_PATH } : {}) });
const report = {
  startedAt: new Date().toISOString(), engine, browserVersion: browser.version(), headless,
  viewport: viewportSize, baseUrl: baseUrl.origin, rounds, variants,
  proofBoundary: 'Production UI with synthetic IPC, driven by browser keyboard/mouse. Not native macOS IME, Tauri backend, provider, or MacBook Air hardware proof. Timings are two-rAF proxies.',
  benchmarks: [], behaviors: [], failures: [],
};
const save = async (name, data) => fs.writeFile(path.join(outputDir, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
const paneSelector = (letter = 'A') => `[data-perf-session="${letter}"]`;
const editorSelector = (letter = 'A') => `${paneSelector(letter)} [contenteditable="true"]`;
const viewportSelector = (letter = 'A') => `${paneSelector(letter)} [data-radix-scroll-area-viewport]`;
const normalize = (text) => text.replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n');

async function newFixture(variant) {
  const context = await browser.newContext({ viewport: viewportSize });
  let clipboardPermission = false;
  if (engine === 'chromium') {
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      clipboardPermission = true;
    } catch { /* Clipboard verification remains explicitly unsupported. */ }
  }
  await context.addInitScript(() => {
    let nextCallback = 1;
    const callbacks = new Map();
    // Browser-only bootstrap. Every invoke still uses the fixture's isolated
    // command dispatcher; no real Tauri or network fallback is provided.
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback, once = false) {
        const id = nextCallback++;
        callbacks.set(id, (...args) => { if (once) callbacks.delete(id); return callback(...args); });
        return id;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      runCallback(id, data) { return callbacks.get(id)?.(data); },
      invoke(command, args, options) {
        if (!window.__workspaceInteractionInvoke) throw new Error(`Fixture IPC unavailable for ${command}`);
        return window.__workspaceInteractionInvoke(command, args, options);
      },
      convertFileSrc() { throw new Error('Fixture blocks native file URLs'); },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.isTauri = true;
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.setDefaultTimeout(12000);
  try {
    await page.goto(new URL(`/test/.artifacts/workspace-interaction-performance/${variant}/index.html`, baseUrl).href,
      { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.bringToFront();
    await page.waitForFunction(() => Boolean(window.__workspaceInteractionPerf), null, { timeout: 30000 });
    await page.evaluate(() => window.__workspaceInteractionPerf.warmup());
    const initial = await page.evaluate(() => window.__workspaceInteractionPerf.diagnostics());
    assert.equal(initial.layout.valid, true, `Invalid fixture bounds: ${JSON.stringify(initial.layout)}`);
    assert.equal(initial.environment.visibility, 'visible', 'Background pages cannot provide benchmark timing evidence');
    assert.equal(initial.build.variant, variant);
    return { page, context, pageErrors, consoleErrors, clipboardPermission, initial };
  } catch (error) {
    await save(`${variant}-bootstrap-failed`, { error: String(error.stack ?? error), pageErrors, consoleErrors });
    await page.screenshot({ path: path.join(outputDir, `${variant}-bootstrap-failed.png`) }).catch(() => {});
    await context.close();
    throw error;
  }
}

async function snapshot(page, finish = false) {
  return page.evaluate((end) => end
    ? window.__workspaceInteractionPerf.finishMetrics()
    : window.__workspaceInteractionPerf.diagnostics(), finish);
}

function assertHealthy(snapshotValue, pageErrors) {
  assert.equal(snapshotValue.layout.valid, true, 'Viewport must stay bounded');
  assert.equal(snapshotValue.environment.visibility, 'visible', 'Page must stay visible');
  assert.deepEqual(pageErrors, [], 'Unhandled browser errors');
  assert.deepEqual(snapshotValue.errors, [], 'Unhandled fixture errors');
  assert.deepEqual(snapshotValue.blockedCommands, [], 'No native mutation should be attempted');
}

async function selectSession(page, letter) {
  await page.getByTestId(`perf-session-${letter}`).click();
  await page.waitForFunction((selected) => {
    const button = document.querySelector(`[data-testid="perf-session-${selected}"]`);
    const pane = document.querySelector(`[data-perf-session="${selected}"]`);
    return button?.getAttribute('aria-pressed') === 'true' && pane?.getBoundingClientRect().height > 0;
  }, letter);
  await page.locator(editorSelector(letter)).waitFor({ state: 'visible' });
  await page.waitForTimeout(180);
}

async function editorState(page, letter = 'A') {
  return page.locator(editorSelector(letter)).evaluate((element) => ({
    text: element.innerText, height: element.getBoundingClientRect().height,
    clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
  }));
}

async function waitForEditorHeight(page, height) {
  await page.waitForFunction(({ selector, expected }) => {
    const element = document.querySelector(selector);
    return element && Math.abs(element.getBoundingClientRect().height - expected) < 0.01;
  }, { selector: editorSelector(), expected: height });
}

async function visibleToolGroup(page) {
  const viewport = page.locator(viewportSelector());
  const groups = page.locator(`${paneSelector()} .workspace-tool-digest-virtualized`);
  for (let attempt = 0; attempt < 10; attempt++) {
    const bounds = await viewport.boundingBox();
    for (let index = 0; index < await groups.count(); index++) {
      const candidate = groups.nth(index);
      const box = await candidate.boundingBox();
      if (box && box.y >= bounds.y + 8 && box.y + Math.min(box.height, 36) <= bounds.y + bounds.height - 8) {
        const key = await candidate.getAttribute('data-transcript-item-key');
        return { key, group: page.locator(`${paneSelector()} [data-transcript-item-key=${JSON.stringify(key)}]`) };
      }
    }
    await viewport.hover();
    await page.mouse.wheel(0, -350);
    await page.waitForTimeout(200);
  }
  throw new Error('No visible tool group after native browser scrolling');
}

async function selectionAndCopy(page, clipboardPermission) {
  const viewport = page.locator(viewportSelector());
  let paragraph = null;
  for (let attempt = 0; attempt < 8 && !paragraph; attempt++) {
    const bounds = await viewport.boundingBox();
    const paragraphs = page.locator(`${paneSelector()} .workspace-msg-virtualized p`);
    for (let index = 0; index < await paragraphs.count(); index++) {
      const item = paragraphs.nth(index);
      const box = await item.boundingBox();
      if (box && box.width > 100 && box.height > 10 && box.y >= bounds.y + 5
        && box.y + Math.min(box.height, 24) < bounds.y + bounds.height - 5
        && (await item.innerText()).trim().length > 12) {
        paragraph = { item, box };
        break;
      }
    }
    if (!paragraph) {
      await viewport.hover();
      await page.mouse.wheel(0, 180);
      await page.waitForTimeout(200);
    }
  }
  assert.ok(paragraph, 'A real visible paragraph must be available for selection');
  const { box } = paragraph;
  await page.mouse.move(box.x + 2, box.y + 9);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 5, 230), box.y + 9, { steps: 16 });
  await page.mouse.up();
  const selection = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  assert.ok(selection.trim().length >= 3, 'Pointer drag must select real transcript text');
  const result = { selection, copy: { status: 'unsupported', reason: 'Clipboard permission unavailable in this engine' } };
  if (clipboardPermission && await page.evaluate(() => Boolean(navigator.clipboard?.readText))) {
    await page.keyboard.press('ControlOrMeta+C');
    await page.waitForTimeout(100);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(normalize(copied), normalize(selection), 'Clipboard must contain the selected transcript text');
    result.copy = { status: 'passed', copied };
  }
  return result;
}

async function runBehavior(variant) {
  const entry = { variant, status: 'running', checks: [], proofBoundary: report.proofBoundary };
  let fixture;
  try {
    fixture = await newFixture(variant);
    const { page } = fixture;
    const editor = page.locator(editorSelector());
    const draft = 'Performance check: keep the complete interface, preserve every draft, and update only the work that changed. '.repeat(3).slice(0, 200);
    await editor.click();
    await page.evaluate(installEditorStyleMutationProbe);
    await page.evaluate(() => window.__workspaceInteractionPerf.resetMetrics('browser-keyboard-typing'));
    await page.keyboard.type(draft, { delay: 16 });
    await page.waitForTimeout(200);
    entry.typing = await snapshot(page, true);
    entry.typing.editorStyleMutations = await page.evaluate(() => window.__workspaceInputStyleProbe.stop());
    const oneLine = await editorState(page);
    assert.equal(normalize(oneLine.text), draft, 'Every typed character must reach the actual composer');
    assert.ok(entry.typing.editorCounters.inputEvents > 0, 'Real input events must reach the composer');
    assert.ok(entry.typing.editorCounters.trustedInputs > 0, 'Playwright must drive browser input, not dispatch a synthetic InputEvent');
    entry.checks.push({ name: 'browser-keyboard-typing', status: 'passed', characters: draft.length, state: oneLine });

    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type(`Line ${index + 1}: the editor grows and keeps this unsent text.`, { delay: 1 });
    }
    await page.waitForTimeout(350);
    const grown = await editorState(page);
    assert.ok(grown.height > oneLine.height + 16, `Editor should grow (${oneLine.height} -> ${grown.height})`);
    assert.ok(grown.text.includes('Line 12:'), 'Shift+Enter must preserve all multiline content');
    assert.ok(grown.scrollHeight > grown.clientHeight, 'Long draft must exercise the actual height cap');
    await page.screenshot({ path: path.join(outputDir, `${variant}-composer-grown.png`) });
    await page.evaluate(installEditorStyleMutationProbe);
    await page.keyboard.type(' Additional text at the height limit.', { delay: 16 });
    await page.waitForTimeout(200);
    const capped = await editorState(page);
    const capStyles = await page.evaluate(() => window.__workspaceInputStyleProbe.stop());
    assert.equal(capped.height, grown.height, 'Typing beyond the cap must keep the rendered editor height');
    const longDraft = capped.text;
    await page.getByTestId('perf-reset-metrics').click();
    await waitForEditorHeight(page, oneLine.height);
    const blurred = await editorState(page);
    assert.equal(blurred.height, oneLine.height, 'Blur collapses the long draft to its original height');
    await editor.click();
    await waitForEditorHeight(page, capped.height);
    assert.equal((await editorState(page)).height, capped.height, 'Refocus restores the capped height');
    await page.setViewportSize({ ...viewportSize, width: viewportSize.width - 120 });
    await page.keyboard.type('|RESIZE_PROBE|');
    await page.waitForTimeout(200);
    assert.equal((await editorState(page)).height, capped.height, 'Focused width change and input remain capped');
    assert.equal(normalize((await editorState(page)).text).replace('|RESIZE_PROBE|', ''), normalize(longDraft), 'Width change preserves the long draft');
    await page.setViewportSize(viewportSize);
    entry.checks.push({ name: 'capped-input-blur-refocus-and-resize', status: 'passed', capped, blurred, capStyles });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    const retainedDraft = 'Retained draft A. 输入保留。';
    await page.keyboard.type(retainedDraft, { delay: 16 });
    await page.waitForTimeout(350);
    const shrunk = await editorState(page);
    assert.equal(normalize(shrunk.text), retainedDraft);
    assert.ok(shrunk.height < grown.height - 16, `Editor should shrink (${grown.height} -> ${shrunk.height})`);
    assert.ok(shrunk.scrollHeight <= shrunk.clientHeight + 2, 'Short focused draft must not be clipped');
    entry.checks.push({ name: 'multiline-grow-delete-shrink', status: 'passed', grown, shrunk });

    await selectSession(page, 'B');
    assert.equal((await editorState(page, 'B')).text.trim(), '', 'B starts with an independent empty draft');
    await page.locator(editorSelector('B')).click();
    await page.keyboard.type('Independent draft B', { delay: 16 });
    await selectSession(page, 'C');
    assert.equal((await editorState(page, 'C')).text.trim(), '', 'C starts with an independent empty draft');
    await selectSession(page, 'A');
    assert.equal(normalize((await editorState(page)).text), retainedDraft, 'A draft survives A-B-C-A');
    await selectSession(page, 'B');
    assert.equal((await editorState(page, 'B')).text, 'Independent draft B');
    await selectSession(page, 'A');
    entry.checks.push({ name: 'independent-draft-survives-switch', status: 'passed' });

    const { key, group } = await visibleToolGroup(page);
    const toggle = group.locator('button[aria-expanded]').first();
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
    await page.waitForTimeout(350);
    const collapsedHeight = (await group.boundingBox()).height;
    await toggle.click();
    await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-expanded') === 'true',
      `${paneSelector()} [data-transcript-item-key=${JSON.stringify(key)}] button[aria-expanded]`);
    await page.waitForTimeout(350);
    const expandedHeight = (await group.boundingBox()).height;
    assert.ok(expandedHeight > collapsedHeight + 16, 'Opening a tool group must display its real body');
    await selectSession(page, 'B');
    await selectSession(page, 'A');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'The opened tool group survives switching');
    await toggle.click();
    await page.waitForTimeout(350);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.ok((await group.boundingBox()).height < expandedHeight - 16, 'Closing a tool group must collapse its body');
    entry.checks.push({ name: 'tool-fold-and-switch-retention', status: 'passed', key, collapsedHeight, expandedHeight });
    entry.selection = await selectionAndCopy(page, fixture.clipboardPermission);
    entry.checks.push({ name: 'pointer-text-selection', status: 'passed' });
    entry.checks.push({ name: 'clipboard-copy', ...entry.selection.copy });
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Continued.', { delay: 16 });
    assert.ok((await editorState(page)).text.includes('Continued.'), 'Typing still works after selection and copy');

    await page.getByTestId('perf-start-stream').click();
    await page.waitForTimeout(450);
    const viewport = page.locator(viewportSelector());
    const bounds = await viewport.boundingBox();
    await viewport.hover();
    await page.mouse.wheel(0, -bounds.height * 3);
    await page.waitForTimeout(450);
    await page.mouse.wheel(0, -bounds.height * 2);
    await page.waitForTimeout(500);
    const before = (await snapshot(page)).sessions.A;
    assert.ok(before.anchor, 'Reading viewport must have a real visible transcript anchor');
    assert.ok(before.scrollHeight - before.scrollTop - before.viewportHeight > 300, 'Reading test must be away from the tail');
    await page.waitForTimeout(1400);
    const anchorAfter = await page.locator(viewportSelector()).evaluate((element, anchorKey) => {
      const anchor = [...element.querySelectorAll('[data-transcript-item-key]')]
        .find((item) => item.getAttribute('data-transcript-item-key') === anchorKey);
      return anchor ? { key: anchorKey, offset: anchor.getBoundingClientRect().top - element.getBoundingClientRect().top } : null;
    }, before.anchor.key);
    assert.ok(anchorAfter, 'Streaming must keep the current reading anchor mounted');
    assert.ok(Math.abs(anchorAfter.offset - before.anchor.offset) <= 8,
      `Streaming moved the reading anchor by ${anchorAfter.offset - before.anchor.offset}px`);
    await page.screenshot({ path: path.join(outputDir, `${variant}-reading-during-stream.png`) });
    await page.waitForFunction(() => !document.querySelector('[data-testid="perf-start-stream"]').disabled,
      null, { timeout: 15000 });
    await page.waitForTimeout(1000);
    await viewport.hover();
    await page.mouse.wheel(0, 1000000);
    await page.waitForTimeout(450);
    await page.mouse.wheel(0, 1000000);
    await page.waitForTimeout(450);
    const tail = (await snapshot(page)).sessions.A;
    assert.ok(tail.scrollHeight - tail.scrollTop - tail.viewportHeight <= 4, 'Tail remains reachable after reading older messages');
    const lastRow = page.locator(`${paneSelector()} [data-transcript-item-key]`).last();
    assert.ok((await lastRow.innerText()).includes('片段 200'), 'Final stream chunk must be rendered at the reachable tail');
    assert.equal((await page.locator(paneSelector()).innerText()).split('片段 200').length - 1, 1, 'Final chunk must not be duplicated');
    assert.ok((await editorState(page)).text.includes(retainedDraft), 'Streaming must preserve the unsent draft');
    entry.checks.push({ name: 'stream-reading-anchor-and-reachable-tail', status: 'passed', before, anchorAfter, tail });
    entry.final = await snapshot(page, true);
    assertHealthy(entry.final, fixture.pageErrors);
    await page.screenshot({ path: path.join(outputDir, `${variant}-behavior-final.png`) });
    entry.consoleErrors = fixture.consoleErrors;
    entry.status = 'passed';
    console.log(JSON.stringify({ scenario: 'behavior', variant, status: 'passed', checks: entry.checks.map(({ name, status }) => ({ name, status })) }));
  } catch (error) {
    entry.status = 'failed';
    entry.error = String(error.stack ?? error);
    if (fixture) {
      entry.final = await snapshot(fixture.page, true).catch(() => null);
      entry.pageErrors = fixture.pageErrors;
      entry.consoleErrors = fixture.consoleErrors;
      await fixture.page.screenshot({ path: path.join(outputDir, `${variant}-behavior-failed.png`) }).catch(() => {});
    }
    report.failures.push({ scenario: 'behavior', variant, error: entry.error });
    console.error(JSON.stringify({ scenario: 'behavior', variant, status: 'failed', error: String(error) }));
  } finally {
    await save(`${variant}-behavior`, entry);
    report.behaviors.push(entry);
    await fixture?.context.close();
  }
}

async function runBenchmark(variant, roundIndex) {
  let fixture;
  const entry = { variant, round: roundIndex, status: 'running' };
  try {
    fixture = await newFixture(variant);
    const { page } = fixture;
    entry.switches = await page.evaluate(() => window.__workspaceInteractionPerf.benchmarkSwitches(18, 120));
    assert.equal(entry.switches.timings.switchTwoRaf.count, 18, 'All requested switches must be measured');
    assertHealthy(entry.switches, fixture.pageErrors);
    await page.screenshot({ path: path.join(outputDir, `${variant}-round-${roundIndex}-switches.png`) });
    await page.evaluate(() => window.__workspaceInteractionPerf.reset());
    entry.stream = await page.evaluate(() => window.__workspaceInteractionPerf.benchmarkStream({ chunks: 200, intervalMs: 40 }));
    assert.equal(entry.stream.generatedChunks, 200, 'Every configured stream chunk must be generated during capture');
    assertHealthy(entry.stream, fixture.pageErrors);
    await page.screenshot({ path: path.join(outputDir, `${variant}-round-${roundIndex}-stream.png`) });
    entry.consoleErrors = fixture.consoleErrors;
    entry.status = 'passed';
    console.log(JSON.stringify({ scenario: 'benchmark', variant, round: roundIndex, status: 'passed',
      switchP95Ms: entry.switches.timings.switchTwoRaf.p95Ms, streamFrameP95Ms: entry.stream.frames.p95Ms }));
  } catch (error) {
    entry.status = 'failed';
    entry.error = String(error.stack ?? error);
    if (fixture) {
      entry.final = await snapshot(fixture.page, true).catch(() => null);
      entry.pageErrors = fixture.pageErrors;
      await fixture.page.screenshot({ path: path.join(outputDir, `${variant}-round-${roundIndex}-failed.png`) }).catch(() => {});
    }
    report.failures.push({ scenario: 'benchmark', variant, round: roundIndex, error: entry.error });
    console.error(JSON.stringify({ scenario: 'benchmark', variant, round: roundIndex, status: 'failed', error: String(error) }));
  } finally {
    await save(`${variant}-round-${roundIndex}`, entry);
    report.benchmarks.push(entry);
    await fixture?.context.close();
  }
}

try {
  if (runBehaviors) for (const variant of variants) await runBehavior(variant);
  if (runBenchmarks) for (let roundIndex = 1; roundIndex <= rounds; roundIndex++) {
    // Alternate build order to expose thermal/caching order effects.
    const order = roundIndex % 2 ? variants : [...variants].reverse();
    for (const variant of order) await runBenchmark(variant, roundIndex);
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.status = report.failures.length ? 'failed' : 'passed';
  await save('report', report);
  await browser.close();
}
console.log(JSON.stringify({ status: report.status, outputDir, benchmarks: report.benchmarks.length,
  behaviors: report.behaviors.length, failures: report.failures.length }));
if (report.failures.length) process.exitCode = 1;
