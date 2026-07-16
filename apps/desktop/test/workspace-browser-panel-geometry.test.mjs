import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importGeometryModule() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'workspace',
    'browserPanelGeometry.ts',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-browser-panel-geometry-'));
  const outputPath = path.join(tempDir, 'browserPanelGeometry.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('browser panel bounds compensate for app webview zoom', async () => {
  const { buildNativeBrowserBounds } = await importGeometryModule();

  const bounds = buildNativeBrowserBounds({
    left: 900,
    top: 120,
    width: 500,
    height: 700,
  }, 0.9);

  assert.equal(bounds.x, 810);
  assert.equal(bounds.y, 108);
  assert.equal(bounds.width, 450);
  assert.equal(bounds.height, 630);
});

test('browser panel bounds ignore invalid zoom values', async () => {
  const { buildNativeBrowserBounds, normalizeBrowserBoundsZoom } = await importGeometryModule();
  const rect = { left: 10, top: 20, width: 300, height: 400 };

  assert.equal(normalizeBrowserBoundsZoom(''), 1);
  assert.equal(normalizeBrowserBoundsZoom(0), 0.5);
  assert.equal(normalizeBrowserBoundsZoom('1.1'), 1.1);
  assert.deepEqual(buildNativeBrowserBounds(rect, 'not-a-number'), {
    x: 10,
    y: 20,
    width: 300,
    height: 400,
  });
});

test('browser panel bounds clamp stale persisted zoom values', async () => {
  const { buildNativeBrowserBounds, normalizeBrowserBoundsZoom } = await importGeometryModule();

  assert.equal(normalizeBrowserBoundsZoom('1.7'), 1.3);
  assert.equal(normalizeBrowserBoundsZoom('0.2'), 0.5);

  assert.deepEqual(buildNativeBrowserBounds({
    left: 1300,
    top: 130,
    width: 650,
    height: 900,
  }, '1.7'), {
    x: 1690,
    y: 169,
    width: 845,
    height: 1170,
  });
});

test('browser panel app zoom maps CSS pixels to host logical coordinates in the same direction', async () => {
  const { buildNativeBrowserBounds } = await importGeometryModule();
  const rect = { left: 100, top: 40, width: 600, height: 400 };

  for (const zoom of [0.8, 1, 1.25]) {
    assert.deepEqual(buildNativeBrowserBounds(rect, zoom), {
      x: rect.left * zoom,
      y: rect.top * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom,
    });
  }
});
