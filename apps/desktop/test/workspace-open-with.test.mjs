import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/components/workspace/workspaceOpenWith.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const { openCategoryForPath, rankOpenApps } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
);

const apps = [
  { id: 'vscode', name: 'Visual Studio Code', kind: 'editor' },
  { id: 'cursor', name: 'Cursor', kind: 'editor' },
  { id: 'typora', name: 'Typora', kind: 'markdown' },
  { id: 'chrome', name: 'Google Chrome', kind: 'browser' },
  { id: 'preview', name: 'Preview', kind: 'viewer' },
];
const ids = (list) => list.map((app) => app.id);

test('file categories follow the extension, case-insensitively', () => {
  assert.equal(openCategoryForPath('site/index.HTML'), 'web');
  assert.equal(openCategoryForPath('assets/logo.png'), 'image');
  assert.equal(openCategoryForPath('docs/spec.pdf'), 'pdf');
  assert.equal(openCategoryForPath('README.md'), 'markdown');
  assert.equal(openCategoryForPath('src/main.rs'), 'code');
  assert.equal(openCategoryForPath('Makefile'), 'code');
  assert.equal(openCategoryForPath('.github/x.d/config'), 'code');
});

test('suggestions put the best-fitting app kind first for each file type', () => {
  assert.deepEqual(ids(rankOpenApps('index.html', apps).suggested), ['chrome', 'vscode', 'cursor']);
  assert.deepEqual(ids(rankOpenApps('logo.png', apps).suggested), ['preview', 'chrome']);
  assert.deepEqual(ids(rankOpenApps('README.md', apps).suggested), ['typora', 'vscode', 'cursor']);
  assert.deepEqual(ids(rankOpenApps('main.rs', apps).suggested), ['vscode', 'cursor']);
  assert.equal(rankOpenApps('index.html', apps).primary.id, 'chrome');
});

test('suggestions stay short and overflow into other apps', () => {
  const editors = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id, kind: 'editor' }));
  const { suggested, others } = rankOpenApps('main.rs', editors);
  assert.deepEqual(ids(suggested), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(others), ['e', 'f']);
});

test('every installed app is reachable exactly once', () => {
  const { suggested, others } = rankOpenApps('main.rs', apps);
  assert.deepEqual([...ids(suggested), ...ids(others)].sort(), ids(apps).sort());
});

test('a remembered choice becomes the primary app only while it is installed', () => {
  assert.equal(rankOpenApps('main.rs', apps, 'cursor').primary.id, 'cursor');
  assert.equal(rankOpenApps('main.rs', apps, 'zed').primary.id, 'vscode');
});

test('without installed apps the primary action falls back to the system default', () => {
  const ranked = rankOpenApps('main.rs', []);
  assert.equal(ranked.primary, null);
  assert.deepEqual(ranked.suggested, []);
});
