import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importSplitView() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceSplitView.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-split-view-'));
  const outputPath = path.join(tempDir, 'workspaceSplitView.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

const split = await importSplitView();

test('first Cmd+click seeds the split with the session on screen', () => {
  assert.deepEqual(split.toggleSplitPane([], 'a', 'b'), { kind: 'added', paneIds: ['a', 'b'] });
});

test('Cmd+click without a session on screen starts a one-pane group', () => {
  assert.deepEqual(split.toggleSplitPane([], null, 'b'), { kind: 'added', paneIds: ['b'] });
});

test('Cmd+click on a pane member removes it', () => {
  assert.deepEqual(split.toggleSplitPane(['a', 'b', 'c'], 'a', 'b'), {
    kind: 'removed',
    paneIds: ['a', 'c'],
  });
});

test('removing down to one pane dissolves the group', () => {
  assert.deepEqual(split.toggleSplitPane(['a', 'b'], 'a', 'b'), { kind: 'removed', paneIds: [] });
});

test('a leftover single pane yields to the session on screen', () => {
  assert.deepEqual(split.toggleSplitPane(['old'], 'x', 'y'), { kind: 'added', paneIds: ['x', 'y'] });
});

test('existing panes win over the seed', () => {
  assert.deepEqual(split.toggleSplitPane(['a', 'b'], 'z', 'c'), {
    kind: 'added',
    paneIds: ['a', 'b', 'c'],
  });
});

test('a fifth pane is refused without changing the layout', () => {
  const panes = ['a', 'b', 'c', 'd'];
  assert.deepEqual(split.toggleSplitPane(panes, 'a', 'e'), { kind: 'full', paneIds: panes });
  assert.equal(split.MAX_SPLIT_PANES, 4);
});

test('prune keeps identity when nothing disappeared', () => {
  const panes = ['a', 'b'];
  assert.equal(split.pruneSplitPanes(panes, new Set(['a', 'b', 'x'])), panes);
  assert.deepEqual(split.pruneSplitPanes(['a', 'b', 'c'], new Set(['a', 'c'])), ['a', 'c']);
  assert.deepEqual(split.pruneSplitPanes(panes, new Set(['b'])), []);
});

test('split shows only while the focused session is a member', () => {
  assert.equal(split.isSplitViewShown(['a', 'b'], 'a'), true);
  assert.equal(split.isSplitViewShown(['a', 'b'], 'c'), false);
  assert.equal(split.isSplitViewShown(['a'], 'a'), false);
  assert.equal(split.isSplitViewShown(['a', 'b'], null), false);
});

test('closing the focused pane moves focus to its neighbour', () => {
  assert.equal(split.focusAfterClosingPane(['a', 'b', 'c'], 'b', 'b'), 'c');
  assert.equal(split.focusAfterClosingPane(['a', 'b', 'c'], 'c', 'c'), 'b');
  assert.equal(split.focusAfterClosingPane(['a', 'b', 'c'], 'c', 'a'), 'a');
});

test('grid picks the layout whose tighter pane dimension is roomiest', () => {
  // Wide desktop: side by side.
  assert.deepEqual(split.splitGridLayout(2, 1200, 800), { columns: 2, rows: 1 });
  assert.deepEqual(split.splitGridLayout(3, 1200, 800), { columns: 3, rows: 1 });
  // Narrow and short: 2x2 beats three 198px columns or three 213px rows.
  assert.deepEqual(split.splitGridLayout(3, 594, 640), { columns: 2, rows: 2 });
  // Tall and narrow: stack.
  assert.deepEqual(split.splitGridLayout(2, 500, 1100), { columns: 1, rows: 2 });
  // Four panes stay balanced.
  assert.deepEqual(split.splitGridLayout(4, 1100, 800), { columns: 2, rows: 2 });
  assert.deepEqual(split.splitGridLayout(4, 1800, 700), { columns: 4, rows: 1 });
  assert.notDeepEqual(split.splitGridLayout(4, 1000, 800), { columns: 3, rows: 2 });
});

test('history pane ids are namespaced apart from runtime ids', () => {
  const id = split.toSplitHistoryPaneId('codex:01a14fa2');
  assert.equal(id, 'history:codex:01a14fa2');
  assert.equal(split.isSplitHistoryPaneId(id), true);
  assert.equal(split.isSplitHistoryPaneId('native-0c48d584'), false);
  // History and live panes share one group and one toggle.
  assert.deepEqual(split.toggleSplitPane([], 'native-a', id), { kind: 'added', paneIds: ['native-a', id] });
});
