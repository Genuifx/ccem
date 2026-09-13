import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importScrollControlModule() {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceTranscriptScrollControl.ts'),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-scroll-control-'));
  const outputPath = path.join(tempDir, 'workspaceTranscriptScrollControl.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const expose = (name, value) => Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  expose('window', dom.window);
  expose('document', dom.window.document);
  expose('HTMLElement', dom.window.HTMLElement);
  expose('Element', dom.window.Element);
  expose('Event', dom.window.Event);
  return dom;
}

/**
 * Controlled geometry: jsdom has no layout engine, so element rects come from
 * an explicit table the test mutates to simulate content growth/shrink.
 * Positions in the table are LAYOUT positions; descendants of the scroll
 * container report them relative to the container's current scrollTop, the
 * way a real browser does.
 */
function installRectTable(scrollContainer) {
  const rects = new Map();
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function patched() {
    const base = original.call(this);
    const override = rects.get(this);
    if (!override) {
      return base;
    }
    const shift = scrollContainer && scrollContainer !== this && scrollContainer.contains(this)
      ? scrollContainer.scrollTop
      : 0;
    return { ...base, top: override.top - shift, bottom: override.bottom - shift };
  };
  return {
    rects,
    restore() {
      window.HTMLElement.prototype.getBoundingClientRect = original;
    },
  };
}

function setBox(element, { top, bottom }) {
  element.__box = { top, bottom };
}

function makeContainer({ top = 0, scrollTop = 0, measurable = true } = {}) {
  const container = document.createElement('div');
  setBox(container, { top, bottom: top + 600 });
  if (measurable) {
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 360 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 600 });
  }
  container.scrollTop = scrollTop;
  return container;
}

function makeItem(container, key, { top, height = 100 }) {
  const item = document.createElement('div');
  item.dataset.transcriptItemKey = key;
  setBox(item, { top, bottom: top + height });
  container.appendChild(item);
  return item;
}

/**
 * Wire the rect table to the recorded boxes: jsdom returns all-zero rects, so
 * every element with a recorded box reports it.
 */
function syncRects(rectTable, elements) {
  for (const element of elements) {
    if (element.__box) {
      rectTable.rects.set(element, element.__box);
    }
  }
}

test('reading anchor picks the first item intersecting the viewport top', async () => {
  const dom = installDom();
  const mod = await importScrollControlModule();
  const rectTable = installRectTable(null);
  try {
    const container = makeContainer({ top: 0 });
    const above = makeItem(container, 'above', { top: -400, height: 100 });
    const visible = makeItem(container, 'visible', { top: -20, height: 120 });
    const below = makeItem(container, 'below', { top: 100, height: 100 });
    syncRects(rectTable, [container, above, visible, below]);

    const anchor = mod.findTranscriptReadingAnchor(container, container);
    assert.equal(anchor.key, 'visible');
    assert.equal(anchor.viewportTopOffset, -20);

    // An item starting exactly at the viewport edge also intersects (bottom > top + 1).
    setBox(visible, { top: 0, bottom: 120 });
    syncRects(rectTable, [visible]);
    const edgeAnchor = mod.findTranscriptReadingAnchor(container, container);
    assert.equal(edgeAnchor.key, 'visible');
    assert.equal(edgeAnchor.viewportTopOffset, 0);

    // No item reaches the viewport top → no anchor.
    setBox(visible, { top: -150, bottom: -100 });
    setBox(above, { top: -400, bottom: -300 });
    setBox(below, { top: -120, bottom: -110 });
    syncRects(rectTable, [visible, above, below]);
    assert.equal(mod.findTranscriptReadingAnchor(container, container), null);
  } finally {
    rectTable.restore();
    dom.window.close();
  }
});

test('reading anchor compensation absorbs growth above the viewport and is idempotent', async () => {
  const dom = installDom();
  const mod = await importScrollControlModule();
  const container = makeContainer({ top: 0, scrollTop: 1200 });
  const rectTable = installRectTable(container);
  try {
    // Layout position 1280 → reported top 80 at scrollTop 1200.
    const anchorItem = makeItem(container, 'anchor', { top: 1280, height: 120 });
    syncRects(rectTable, [container, anchorItem]);

    const anchor = { key: 'anchor', viewportTopOffset: 80 };
    // Content above grew by 40px: the anchor item moved down in the viewport.
    setBox(anchorItem, { top: 1320, bottom: 1440 });
    syncRects(rectTable, [anchorItem]);

    const applied = mod.applyTranscriptReadingAnchor(container, container, anchor);
    assert.equal(applied, 40);
    assert.equal(container.scrollTop, 1240);

    // Compensating again is a no-op (the scrollTop shift moved the anchor
    // back to its captured viewport offset).
    assert.equal(mod.applyTranscriptReadingAnchor(container, container, anchor), 0);
    assert.equal(container.scrollTop, 1240);

    // Shrink above the viewport walks it back symmetrically.
    setBox(anchorItem, { top: 1300, bottom: 1420 });
    syncRects(rectTable, [anchorItem]);
    assert.equal(mod.applyTranscriptReadingAnchor(container, container, anchor), -20);
    assert.equal(container.scrollTop, 1220);
  } finally {
    rectTable.restore();
    dom.window.close();
  }
});

test('missing anchor element or empty key never moves the scroll position', async () => {
  const dom = installDom();
  const mod = await importScrollControlModule();
  const container = makeContainer({ top: 0, scrollTop: 500 });
  const rectTable = installRectTable(container);
  try {
    const item = makeItem(container, 'item', { top: 510, height: 100 });
    syncRects(rectTable, [container, item]);

    assert.equal(
      mod.applyTranscriptReadingAnchor(container, container, { key: 'windowed-away', viewportTopOffset: 10 }),
      0,
    );
    assert.equal(mod.applyTranscriptReadingAnchor(container, container, { key: '', viewportTopOffset: 10 }), 0);
    assert.equal(container.scrollTop, 500);
  } finally {
    rectTable.restore();
    dom.window.close();
  }
});

test('user scroll intervention detection requires a material distance from the programmatic target', async () => {
  const dom = installDom();
  const mod = await importScrollControlModule();
  try {
    assert.equal(
      mod.isTranscriptUserScrollIntervention({ programmaticTarget: 1000, currentScrollTop: 1000 }),
      false,
    );
    assert.equal(
      mod.isTranscriptUserScrollIntervention({ programmaticTarget: 1000, currentScrollTop: 998 }),
      false,
    );
    assert.equal(
      mod.isTranscriptUserScrollIntervention({ programmaticTarget: 1000, currentScrollTop: 960 }),
      true,
    );
    assert.equal(
      mod.isTranscriptUserScrollIntervention({ programmaticTarget: 1000, currentScrollTop: 1040 }),
      true,
    );
  } finally {
    dom.window.close();
  }
});

test('compensator falls back to the content-height delta when the anchor row is replaced (re-key)', async () => {
  const dom = installDom();
  const mod = await importScrollControlModule();
  const content = document.createElement('div');
  document.body.appendChild(content);
  const container = makeContainer({ top: 0, scrollTop: 0 });
  content.appendChild(container);
  const rectTable = installRectTable(container);
  try {
    // Simulated re-key: the anchor element is REPLACED by a different element
    // with a different key (pending turn finalizing its provider uuid).
    const item = makeItem(container, 'pending-anchor', { top: 900, height: 200 });
    syncRects(rectTable, [container, item]);
    let scrollHeightValue = 2000;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => scrollHeightValue });

    const controller = mod.attachTranscriptResizeCompensator({
      container,
      getContentElement: () => container,
      isFollowMode: () => false,
      scrollToBottom: () => {},
    });

    // Read mid-list: scrollTop 800 puts the anchor at viewport offset 100.
    container.scrollTop = 800;
    container.dispatchEvent(new window.Event('scroll'));
    controller.handleContentResize();
    assert.equal(container.scrollTop, 800, 'no movement while the anchor is intact');

    // Replace the row AND grow the content above it by 60px.
    item.remove();
    const replacement = makeItem(container, 'final-uuid-anchor', { top: 960, height: 200 });
    syncRects(rectTable, [replacement]);
    scrollHeightValue = 2060;
    controller.handleContentResize();
    assert.equal(container.scrollTop, 860, 'delta fallback holds the reading position');

    // A later resize with no anchor reference left keeps using the refreshed
    // height baseline (no double compensation).
    controller.handleContentResize();
    assert.equal(container.scrollTop, 860);

    controller.dispose();
  } finally {
    rectTable.restore();
    dom.window.close();
  }
});

test('compensator follows the tail on resize and holds the reading anchor otherwise', async () => {
  const dom = installDom();
  const mod = await importScrollControlModule();
  const content = document.createElement('div');
  document.body.appendChild(content);
  const container = makeContainer({ top: 0, scrollTop: 0 });
  content.appendChild(container);
  const rectTable = installRectTable(container);
  try {
    const item = makeItem(container, 'reading', { top: 40, height: 200 });
    syncRects(rectTable, [container, item]);

    let followMode = true;
    let bottomPins = 0;
    const controller = mod.attachTranscriptResizeCompensator({
      container,
      getContentElement: () => container,
      isFollowMode: () => followMode,
      scrollToBottom: () => {
        bottomPins += 1;
      },
    });

    // Follow mode: a late content resize re-pins to the bottom.
    controller.handleContentResize();
    assert.equal(bottomPins, 1);

    // Reading mode: the scroll event captures the anchor, a resize above the
    // viewport is then compensated exactly.
    followMode = false;
    container.dispatchEvent(new window.Event('scroll'));
    controller.handleContentResize();
    assert.equal(container.scrollTop, 0, 'anchor at offset 40 stays at 40 — no move');

    setBox(item, { top: 90, bottom: 290 });
    syncRects(rectTable, [item]);
    controller.handleContentResize();
    assert.equal(container.scrollTop, 50);

    // A hidden (display:none) container never acts, even in follow mode.
    followMode = true;
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 0 });
    controller.handleContentResize();
    assert.equal(bottomPins, 1);

    controller.dispose();
    setBox(item, { top: 190, bottom: 390 });
    syncRects(rectTable, [item]);
    container.dispatchEvent(new window.Event('scroll'));
    assert.equal(container.scrollTop, 50, 'after dispose no listener remains');
  } finally {
    rectTable.restore();
    dom.window.close();
  }
});
