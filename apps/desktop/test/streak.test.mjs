/**
 * Behavior tests for the shared streak util (src/lib/streak.ts).
 * Verifies: today-grace (an in-progress day with no usage yet keeps the
 * trailing streak), genuine break detection, local-calendar day keys across
 * month boundaries, and just-after-midnight views. Mirrors
 * calculate_streak tests in src-tauri/src/analytics.rs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, stop as stopEsbuild } from 'esbuild';

const desktopDir = path.resolve(import.meta.dirname, '..');
let tempDir;

test.after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  stopEsbuild();
  setTimeout(() => process.exit(0), 100).unref();
});

const aliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, (args) => ({
      path: path.join(desktopDir, 'src', args.path.slice(2)),
    }));
  },
};

async function loadStreakUtil() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-streak-test-'));
  const outfile = path.join(tempDir, 'streak.mjs');
  await build({
    entryPoints: [path.join(desktopDir, 'src/lib/streak.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    plugins: [aliasPlugin],
    logLevel: 'silent',
  });
  return import(outfile);
}

const key = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function historyFromLastDay(lastDay, days) {
  const history = {};
  let cursor = new Date(lastDay.getTime());
  for (let i = 0; i < days; i += 1) {
    history[key(cursor)] = { inputTokens: 1 };
    cursor.setDate(cursor.getDate() - 1);
  }
  return history;
}

test('streak util counts consecutive days including an active today', async () => {
  const { calculateContinuousUsageDays } = await loadStreakUtil();
  const today = new Date(2026, 9, 14, 15, 0);
  const history = historyFromLastDay(today, 5);

  assert.equal(calculateContinuousUsageDays(history, today), 5);
});

test('streak util grants grace for a day with no usage yet', async () => {
  const { calculateContinuousUsageDays } = await loadStreakUtil();
  // Morning view: nothing used yet today, 4 trailing days through yesterday.
  const today = new Date(2026, 9, 14, 8, 0);
  const yesterday = new Date(2026, 9, 13, 23, 0);
  const history = historyFromLastDay(yesterday, 4);

  assert.equal(calculateContinuousUsageDays(history, today), 4);
});

test('streak util just after midnight keeps yesterday-ending streak', async () => {
  const { calculateContinuousUsageDays } = await loadStreakUtil();
  const justAfterMidnight = new Date(2026, 9, 14, 0, 5);
  const history = historyFromLastDay(new Date(2026, 9, 13, 20, 0), 9);

  assert.equal(calculateContinuousUsageDays(history, justAfterMidnight), 9);
});

test('streak util reports zero when the streak is genuinely broken', async () => {
  const { calculateContinuousUsageDays } = await loadStreakUtil();
  const today = new Date(2026, 9, 14, 10, 0);
  // Latest usage is two days ago: today and yesterday are both empty.
  const history = historyFromLastDay(new Date(2026, 9, 12, 18, 0), 3);

  assert.equal(calculateContinuousUsageDays(history, today), 0);
  assert.equal(calculateContinuousUsageDays({}, today), 0);
});

test('streak util walks local calendar days across a month boundary', async () => {
  const { calculateContinuousUsageDays } = await loadStreakUtil();
  const today = new Date(2026, 9, 3, 9, 0);
  const history = historyFromLastDay(new Date(2026, 9, 2, 22, 0), 3); // Oct 2, Oct 1, Sep 30

  assert.ok(history['2026-09-30'] && history['2026-10-01'] && history['2026-10-02']);
  assert.equal(calculateContinuousUsageDays(history, today), 3);
});
