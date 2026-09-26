import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/components/workspace/composerFileDrop.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const { composerFileDropPoint, isComposerFileDropInside } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
const rect = { left: 100, top: 500, right: 700, bottom: 700, width: 600, height: 200 };
const mac = { platform: 'MacIntel', devicePixelRatio: 2, appZoom: 1 };

test('macOS AppKit points are not divided by the display scale', () => {
  for (const devicePixelRatio of [1, 2]) {
    const space = { ...mac, devicePixelRatio };
    assert.deepEqual(composerFileDropPoint({ x: 400, y: 600 }, space), { x: 400, y: 600 });
    assert.equal(isComposerFileDropInside(rect, { x: 400, y: 600 }, space), true);
  }
});

test('macOS page zoom is undone once, independently of Retina and WebKit DPR behavior', () => {
  for (const appZoom of [0.5, 0.8, 1, 1.3]) {
    for (const devicePixelRatio of [1, 2, 2 * appZoom]) {
      const space = { ...mac, appZoom, devicePixelRatio };
      assert.deepEqual(composerFileDropPoint({ x: 400 * appZoom, y: 600 * appZoom }, space), { x: 400, y: 600 });
      assert.equal(isComposerFileDropInside(rect, { x: 400 * appZoom, y: 600 * appZoom }, space), true);
    }
  }
});

test('other platforms retain the physical-pixel to CSS-pixel conversion', () => {
  for (const platform of ['Win32', 'Linux x86_64', '']) {
    for (const devicePixelRatio of [1, 1.25, 1.5, 2, 2.6]) {
      const space = { platform, devicePixelRatio, appZoom: 1.3 };
      assert.deepEqual(composerFileDropPoint({ x: 400 * devicePixelRatio, y: 600 * devicePixelRatio }, space), { x: 400, y: 600 });
    }
  }
});

test('only the composer rectangle accepts drops, without trying a second coordinate interpretation', () => {
  for (const position of [{ x: 100, y: 500 }, { x: 700, y: 700 }]) {
    assert.equal(isComposerFileDropInside(rect, position, mac), true);
  }
  for (const position of [
    { x: 99, y: 600 }, { x: 701, y: 600 }, { x: 400, y: 499 }, { x: 400, y: 701 },
    // A physical-pixel fallback would falsely accept this far-away point.
    { x: 800, y: 1200 }, { x: -400, y: 600 },
    { x: NaN, y: 600 }, { x: 400, y: Infinity },
  ]) {
    assert.equal(isComposerFileDropInside(rect, position, mac), false);
  }
  assert.equal(isComposerFileDropInside({ ...rect, width: 0 }, { x: 400, y: 600 }, mac), false);
  assert.equal(isComposerFileDropInside({ ...rect, height: 0 }, { x: 400, y: 600 }, mac), false);
});

test('invalid scales fall back to one without creating infinite coordinates', () => {
  for (const invalid of [0, -1, NaN, Infinity]) {
    for (const platform of ['MacIntel', 'Win32']) {
      assert.deepEqual(composerFileDropPoint({ x: 400, y: 600 }, {
        platform, devicePixelRatio: invalid, appZoom: invalid,
      }), { x: 400, y: 600 });
    }
  }
});
