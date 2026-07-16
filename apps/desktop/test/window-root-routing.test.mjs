import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWindowRootRouting() {
  const sourcePath = path.join(desktopDir, 'src', 'lib', 'windowRootRouting.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-window-root-routing-'));
  const outputPath = path.join(tempDir, 'windowRootRouting.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('query routing selects supported dedicated desktop windows', async () => {
  const { resolveDesktopWindowRoot } = await importWindowRootRouting();

  assert.equal(resolveDesktopWindowRoot('desktop-pet', 'main'), 'desktop-pet');
  assert.equal(resolveDesktopWindowRoot('tray-cockpit', 'main'), 'tray-cockpit');
  assert.equal(resolveDesktopWindowRoot('login-browser-control', 'main'), 'main');
});

test('native window label is the fallback when the query is absent', async () => {
  const { resolveDesktopWindowRoot } = await importWindowRootRouting();

  assert.equal(resolveDesktopWindowRoot(null, 'login-browser-control'), 'main');
  assert.equal(resolveDesktopWindowRoot(null, 'tray-cockpit'), 'tray-cockpit');
  assert.equal(resolveDesktopWindowRoot(null, 'main'), 'main');
});

test('unknown query values cannot override a recognized native window label', async () => {
  const { resolveDesktopWindowRoot } = await importWindowRootRouting();

  assert.equal(resolveDesktopWindowRoot('untrusted-window', 'desktop-pet'), 'desktop-pet');
  assert.equal(resolveDesktopWindowRoot('untrusted-window', 'unknown'), 'main');
});
