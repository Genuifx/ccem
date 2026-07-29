import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importTypeScriptModule(relativePath) {
  const source = await fs.readFile(
    path.join(desktopDir, ...relativePath),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ccem-settings-persistence-test-'),
  );
  const outputPath = path.join(tempDir, path.basename(relativePath.at(-1), '.ts') + '.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('generic settings persistence waits only for its own backend snapshot', async () => {
  const { canPersistSettings } = await importTypeScriptModule(
    ['src', 'pages', 'settingsPersistence.ts'],
  );

  assert.equal(canPersistSettings(false), false);
  assert.equal(
    canPersistSettings(true),
    true,
    'language is persisted through its dedicated command, not this generic path',
  );
});

test('language persistence queue never overlaps writes', async () => {
  const { createSerialTaskQueue } = await importTypeScriptModule(
    ['src', 'lib', 'serialTaskQueue.ts'],
  );
  const calls = [];
  const resolvers = [];
  const queue = createSerialTaskQueue(
    (language) => new Promise((resolve) => {
      calls.push(language);
      resolvers.push(resolve);
    }),
  );

  const zhSave = queue('zh');
  const enSave = queue('en');
  await Promise.resolve();
  assert.deepEqual(calls, ['zh']);

  resolvers[0]();
  await zhSave;
  await Promise.resolve();
  assert.deepEqual(calls, ['zh', 'en']);

  resolvers[1]();
  await enSave;
});
