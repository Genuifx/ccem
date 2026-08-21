import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importTopWindowing() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'workspace',
    'workspaceTranscriptTopWindowing.ts',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-top-windowing-'));
  const outputPath = path.join(tempDir, 'workspaceTranscriptTopWindowing.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

async function withModule(run) {
  const mod = await importTopWindowing();
  return run(mod);
}

test('median fallback ignores a single giant expanded row', async () => {
  await withModule((mod) => {
    const cache = mod.createTranscriptItemHeightCache();
    cache.width = 900;
    // ~45 measured rows of ~100px plus ONE dynamically expanded digest.
    for (let index = 0; index < 45; index += 1) {
      cache.heights.set(`item-${index}`, 100);
    }
    cache.heights.set('expanded-digest', 3000);

    const median = mod.medianMeasuredItemHeight(cache.heights);
    assert.ok(
      Math.abs(median - 100) <= 1,
      `median stays ~100 even with a 3000px outlier (got ${median})`,
    );

    // The spacer for 355 never-measured hidden rows must not drift by tens of
    // thousands of pixels: 355 * ~100, not 355 * mean(≈163).
    const unknownKeys = Array.from({ length: 355 }, (_, index) => `unknown-${index}`);
    const spacer = mod.computeTopSpacerHeight(unknownKeys, cache);
    assert.ok(
      Math.abs(spacer - 355 * 100) <= 355,
      `unknown-row spacer stays within ±1px/row of the median (got ${spacer})`,
    );
  });
});

test('known keys use their own measured outer height, unknown keys the median', async () => {
  await withModule((mod) => {
    const cache = mod.createTranscriptItemHeightCache();
    cache.width = 900;
    cache.heights.set('known-tall', 2000);
    cache.heights.set('known-a', 120);
    cache.heights.set('known-b', 130);

    assert.equal(mod.estimateTranscriptItemHeight(cache, 'known-tall'), 2000);
    // Unknown rows get the median of {120, 130, 2000} = 130 — not the mean 750.
    const unknown = mod.estimateTranscriptItemHeight(cache, 'unknown');
    assert.equal(unknown, 130);

    const spacer = mod.computeTopSpacerHeight(['known-tall', 'u1', 'u2', 'u3'], cache);
    assert.equal(spacer, 2000 + 3 * 130);
  });
});

test('spacer uses cached heights per key so expansion never re-estimates other rows', async () => {
  await withModule((mod) => {
    const cache = mod.createTranscriptItemHeightCache();
    cache.width = 900;
    // 400 rows, all measured at 72 except one expanded to 2400.
    const keys = Array.from({ length: 400 }, (_, index) => `k${index}`);
    keys.forEach((key) => cache.heights.set(key, 72));
    cache.heights.set('k5', 2400);

    const spacerBefore = mod.computeTopSpacerHeight(keys, cache);
    assert.equal(spacerBefore, 399 * 72 + 2400);

    // Expanding ANOTHER row changes only its own contribution.
    cache.heights.set('k200', 2400);
    const spacerAfter = mod.computeTopSpacerHeight(keys, cache);
    assert.equal(spacerAfter, spacerBefore + (2400 - 72));
  });
});

test('window count respects the buffer, the tail floor and clamps at the top', async () => {
  await withModule((mod) => {
    const itemKeys = Array.from({ length: 400 }, (_, index) => `k${index}`);
    const heightCache = mod.createTranscriptItemHeightCache();
    itemKeys.forEach((key) => heightCache.heights.set(key, 120));
    const base = {
      listTopInContent: 0,
      viewportHeight: 600,
      itemKeys,
      heightCache,
    };

    // At the very top nothing is hidden.
    assert.equal(mod.computeNextTopWindowCount({ ...base, scrollTop: 0 }), 0);
    // Inside the 8-viewport buffer nothing is hidden yet.
    assert.equal(mod.computeNextTopWindowCount({ ...base, scrollTop: 8 * 600 }), 0);
    // One median row past the buffer hides exactly one row.
    assert.equal(mod.computeNextTopWindowCount({ ...base, scrollTop: 8 * 600 + 120 }), 1);
    // Never below the min-rendered floor: 400 - 24 = 376 max.
    assert.equal(
      mod.computeNextTopWindowCount({ ...base, scrollTop: 10_000_000 }),
      376,
    );
    // A tiny list never windows at all.
    assert.equal(mod.computeNextTopWindowCount({
      ...base,
      scrollTop: 10_000_000,
      itemKeys: itemKeys.slice(0, 10),
    }), 0);
  });
});

test('window count and spacer use the same cumulative-height model', async () => {
  await withModule((mod) => {
    const itemKeys = Array.from({ length: 400 }, (_, index) => `k${index}`);
    const heightCache = mod.createTranscriptItemHeightCache();
    // The first 180 rows are tall, while a majority of the full list is short.
    // A median-only count estimate would clamp to 376 hidden rows even though
    // their real spacer extends far below the reading position, creating a
    // large blank viewport when the user scrolls upward.
    itemKeys.forEach((key, index) => heightCache.heights.set(key, index < 180 ? 250 : 47));

    const scrollTop = 47_738;
    const listTopInContent = 32;
    const viewportHeight = 425;
    const hideablePx = scrollTop - 8 * viewportHeight - listTopInContent;
    const hiddenCount = mod.computeNextTopWindowCount({
      scrollTop,
      listTopInContent,
      viewportHeight,
      itemKeys,
      heightCache,
    });
    const spacer = mod.computeTopSpacerHeight(itemKeys.slice(0, hiddenCount), heightCache);
    const nextHeight = heightCache.heights.get(itemKeys[hiddenCount]);

    assert.equal(hiddenCount, 177);
    assert.ok(spacer <= hideablePx, 'hidden prefix ends above the viewport buffer');
    assert.ok(spacer + nextHeight > hideablePx, 'the next row would enter the buffer');
    assert.notEqual(hiddenCount, 376, 'never clamp from an unrelated short-row median');
  });
});

test('fully measured transcripts do not rescan heights for an unused fallback', async () => {
  await withModule((mod) => {
    const itemKeys = Array.from({ length: 400 }, (_, index) => `k${index}`);
    const heightCache = mod.createTranscriptItemHeightCache();
    itemKeys.forEach((key) => heightCache.heights.set(key, 120));
    heightCache.heights.values = () => {
      throw new Error('median fallback must stay lazy when every key is measured');
    };

    assert.equal(mod.computeTopSpacerHeight(itemKeys.slice(0, 100), heightCache), 12_000);
    assert.equal(mod.computeNextTopWindowCount({
      scrollTop: 8 * 600 + 120,
      listTopInContent: 0,
      viewportHeight: 600,
      itemKeys,
      heightCache,
    }), 1);
  });
});

test('hidden containers are not measurable so measurement is skipped for them', async () => {
  await withModule((mod) => {
    assert.equal(mod.isWindowingViewportMeasurable(null), false);
    assert.equal(mod.isWindowingViewportMeasurable(undefined), false);
    assert.equal(mod.isWindowingViewportMeasurable({ clientWidth: 0, clientHeight: 0 }), false);
    assert.equal(mod.isWindowingViewportMeasurable({ clientWidth: 900, clientHeight: 0 }), false);
    assert.equal(mod.isWindowingViewportMeasurable({ clientWidth: 900, clientHeight: 600 }), true);
  });
});

test('reading anchors require a real viewport intersection', async () => {
  await withModule((mod) => {
    assert.equal(mod.transcriptItemIntersectsViewport(120, 180, 100, 500), true);
    assert.equal(mod.transcriptItemIntersectsViewport(80, 120, 100, 500), true);
    assert.equal(mod.transcriptItemIntersectsViewport(480, 520, 100, 500), true);
    assert.equal(
      mod.transcriptItemIntersectsViewport(24_000, 24_120, 100, 500),
      false,
      'an item far below a blank viewport must not become its reading anchor',
    );
    assert.equal(mod.transcriptItemIntersectsViewport(-200, -20, 100, 500), false);
  });
});

test('switch-back preserves a restored reading position without blocking normal tail follow', async () => {
  await withModule((mod) => {
    assert.equal(mod.shouldPreserveRestoredReadingPosition({
      becameVisible: true,
      previousEventCount: 5000,
      isNearBottom: false,
    }), true);
    assert.equal(mod.shouldPreserveRestoredReadingPosition({
      becameVisible: true,
      previousEventCount: 0,
      isNearBottom: false,
    }), false, 'initial hydration may still follow the tail');
    assert.equal(mod.shouldPreserveRestoredReadingPosition({
      becameVisible: false,
      previousEventCount: 5000,
      isNearBottom: false,
    }), false, 'ordinary streaming growth keeps using the detached flag');
    assert.equal(mod.shouldPreserveRestoredReadingPosition({
      becameVisible: true,
      previousEventCount: 5000,
      isNearBottom: true,
    }), false, 'a reader already at the tail may keep following it');
  });
});
