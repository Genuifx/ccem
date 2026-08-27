import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importCoordinator() {
  const source = await fs.readFile(path.join(desktopDir, 'src', 'lib', 'envDeleteCoordination.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-env-delete-coord-'));
  const outputPath = path.join(tempDir, 'envDeleteCoordination.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  try {
    return await import(pathToFileURL(outputPath).href);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** Build a fake deps bag that records call order + lets each step fail. */
function makeDeps({ deleteFails, removeFails, persistFails, refreshFails } = {}) {
  const order = [];
  const removed = [];
  return {
    order,
    removed,
    deps: {
      deleteRemote: async () => {
        order.push('delete');
        if (deleteFails) throw new Error('backend rejected');
      },
      removeLocal: () => {
        order.push('removeLocal');
        if (removeFails) throw new Error('local removal threw');
        removed.push('glm');
      },
      persistEnabled: async () => {
        order.push('persist');
        if (persistFails) throw new Error('persist failed');
      },
      refresh: async () => {
        order.push('refresh');
        if (refreshFails) throw new Error('refresh failed');
      },
    },
  };
}

test('deleteRemote failure rejects and does NOT removeLocal / persist / refresh', async () => {
  const { coordinateEnvDelete } = await importCoordinator();
  const { deps, order, removed } = makeDeps({ deleteFails: true });
  await assert.rejects(() => coordinateEnvDelete(deps), /backend rejected/);
  assert.deepEqual(order, ['delete'], 'nothing runs after the commit boundary fails');
  assert.deepEqual(removed, [], 'local state untouched on delete failure');
});

test('delete success + persist failure: resolves with partial error; local removed; refresh still runs', async () => {
  const { coordinateEnvDelete } = await importCoordinator();
  const { deps, order, removed } = makeDeps({ persistFails: true });
  const partial = await coordinateEnvDelete(deps);
  assert.deepEqual(partial, ['could not persist enabled environments']);
  assert.deepEqual(removed, ['glm'], 'local removal applied after commit');
  assert.deepEqual(order, ['delete', 'removeLocal', 'persist', 'refresh'], 'order preserved; refresh not skipped');
});

test('delete success + refresh failure: resolves with partial error; persist ran; local removed', async () => {
  const { coordinateEnvDelete } = await importCoordinator();
  const { deps, order, removed } = makeDeps({ refreshFails: true });
  const partial = await coordinateEnvDelete(deps);
  assert.deepEqual(partial, ['environment list refresh failed; showing locally-removed state']);
  assert.deepEqual(removed, ['glm']);
  assert.deepEqual(order, ['delete', 'removeLocal', 'persist', 'refresh']);
});

test('full success: resolves with empty partials (caller clears error)', async () => {
  const { coordinateEnvDelete } = await importCoordinator();
  const { deps, order, removed } = makeDeps();
  const partial = await coordinateEnvDelete(deps);
  assert.deepEqual(partial, []);
  assert.deepEqual(removed, ['glm']);
  assert.deepEqual(order, ['delete', 'removeLocal', 'persist', 'refresh']);
});

test('removeLocal failure is captured post-commit; persist + refresh still run; resolves', async () => {
  const { coordinateEnvDelete } = await importCoordinator();
  const { deps, order, removed } = makeDeps({ removeFails: true });
  const partial = await coordinateEnvDelete(deps);
  assert.ok(partial.includes('could not apply local removal'), 'local failure surfaced as partial');
  assert.deepEqual(removed, [], 'failed removal did not record');
  assert.deepEqual(order, ['delete', 'removeLocal', 'persist', 'refresh'], 'post-commit steps continue after removeLocal failure');
});

test('removeLocal runs synchronously after commit, before any post-commit await', async () => {
  const { coordinateEnvDelete } = await importCoordinator();
  // deleteRemote resolves on a microtask; removeLocal must still be the very
  // next step (no post-commit await interleaves before the local mutation).
  const order = [];
  await coordinateEnvDelete({
    deleteRemote: async () => { order.push('delete-resolved'); },
    removeLocal: () => { order.push('removeLocal'); },
    persistEnabled: async () => { order.push('persist'); },
    refresh: async () => { order.push('refresh'); },
  });
  assert.deepEqual(order, ['delete-resolved', 'removeLocal', 'persist', 'refresh']);
});
