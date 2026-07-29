import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importTrayRefreshGate() {
  const sourcePath = path.join(desktopDir, 'src', 'lib', 'tray-refresh.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-tray-refresh-test-'));
  const outputPath = path.join(tempDir, 'tray-refresh.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('tray refresh gate coalesces bursts and throttles automatic refreshes', async () => {
  const { createTrayRefreshGate } = await importTrayRefreshGate();
  let now = 10_000;
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const gate = createTrayRefreshGate({
    minIntervalMs: 60_000,
    now: () => now,
  });
  const loader = async () => {
    calls += 1;
    await pending;
  };

  const first = gate.run(loader);
  const burst = Array.from({ length: 20 }, () => gate.run(loader));

  assert.equal(calls, 1);
  assert.ok(burst.every((request) => request === first));

  release();
  assert.equal(await first, true);
  assert.deepEqual(await Promise.all(burst), Array(20).fill(true));

  now += 30_000;
  assert.equal(await gate.run(async () => {
    calls += 1;
  }), false);
  assert.equal(calls, 1);

  assert.equal(await gate.run(async () => {
    calls += 1;
  }, { force: true }), true);
  assert.equal(calls, 2);
});

test('tray refresh gate clears a failed request so the next open can retry', async () => {
  const { createTrayRefreshGate } = await importTrayRefreshGate();
  const gate = createTrayRefreshGate({
    minIntervalMs: 60_000,
    now: () => 10_000,
  });
  let calls = 0;

  await assert.rejects(
    gate.run(async () => {
      calls += 1;
      throw new Error('snapshot failed');
    }),
    /snapshot failed/,
  );

  assert.equal(await gate.run(async () => {
    calls += 1;
  }), true);
  assert.equal(calls, 2);
});

test('tray refresh gate queues one forced refresh behind an automatic refresh', async () => {
  const { createTrayRefreshGate } = await importTrayRefreshGate();
  const gate = createTrayRefreshGate({
    minIntervalMs: 60_000,
    now: () => 10_000,
  });
  let releaseAutomatic;
  let releaseForced;
  let automaticCalls = 0;
  let forcedCalls = 0;
  const automaticPending = new Promise((resolve) => {
    releaseAutomatic = resolve;
  });
  const forcedPending = new Promise((resolve) => {
    releaseForced = resolve;
  });

  const automatic = gate.run(async () => {
    automaticCalls += 1;
    await automaticPending;
  });
  const forced = gate.run(async () => {
    forcedCalls += 1;
    await forcedPending;
  }, { force: true });
  const duplicateForced = gate.run(async () => {
    forcedCalls += 1;
  }, { force: true });

  assert.notEqual(forced, automatic);
  assert.equal(automaticCalls, 1);
  assert.equal(forcedCalls, 0);
  assert.equal(duplicateForced, forced);

  releaseAutomatic();
  assert.equal(await automatic, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(forcedCalls, 1);

  releaseForced();
  assert.equal(await forced, true);
  assert.equal(await duplicateForced, true);
  assert.equal(forcedCalls, 1);
});
