import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importAsyncGuard() {
  const source = await fs.readFile(path.join(desktopDir, 'src', 'lib', 'asyncGuard.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-async-guard-'));
  const outputPath = path.join(tempDir, 'asyncGuard.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  try {
    return await import(pathToFileURL(outputPath).href);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('begin() admits the first call and blocks re-entry until end()', async () => {
  const { createDeleteGuard } = await importAsyncGuard();
  const g = createDeleteGuard();
  assert.equal(g.busy, false);
  assert.equal(g.begin(), true, 'first begin succeeds');
  assert.equal(g.busy, true);
  assert.equal(g.begin(), false, 'second begin in the same window is blocked');
  assert.equal(g.begin(), false, 'still blocked');
  g.end();
  assert.equal(g.busy, false);
  assert.equal(g.begin(), true, 'admitted again after end()');
});

test('each guard instance is independent', async () => {
  const { createDeleteGuard } = await importAsyncGuard();
  const a = createDeleteGuard();
  const b = createDeleteGuard();
  assert.equal(a.begin(), true);
  assert.equal(b.begin(), true, 'separate instances do not share state');
  assert.equal(a.begin(), false);
  assert.equal(b.begin(), false);
});

test('createReentryGuard: generic same-tick mutex for router save/generate', async () => {
  const { createReentryGuard, createDeleteGuard } = await importAsyncGuard();
  const g = createReentryGuard();
  // Two synchronous claims in the same tick: only the first wins (React state
  // could not guarantee this — both handlers would read `false`).
  const first = g.begin();
  const second = g.begin();
  assert.equal(first, true, 'first claim admitted');
  assert.equal(second, false, 'second same-tick claim rejected');
  assert.equal(g.busy, true);
  g.end();
  assert.equal(g.begin(), true, 're-admitted after end()');
  // Backward-compatible alias is the same factory.
  assert.equal(typeof createDeleteGuard, 'function');
});

test('submit-wrapper semantics: same-tick double call blocked, released on finally even when the run throws', async () => {
  const { createReentryGuard } = await importAsyncGuard();
  const guard = createReentryGuard();

  const submit = async (fail) => {
    if (!guard.begin()) return 'blocked';
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (fail) throw new Error('boom');
      return 'ran';
    } finally {
      guard.end();
    }
  };

  // Same-tick double submit: the second call must be blocked synchronously.
  const first = submit(false);
  const second = submit(false); // still the same tick — the guard must block it
  assert.equal(await second, 'blocked');
  assert.equal(await first, 'ran');
  assert.equal(await submit(false), 'ran', 'admitted again after completion');

  // A throwing run must still release the guard (finally).
  await assert.rejects(() => submit(true), /boom/);
  assert.equal(await submit(false), 'ran', 'guard re-armed after a failed run');
});
