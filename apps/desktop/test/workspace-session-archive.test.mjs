import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importSessionArchive() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'sessionArchive.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-session-archive-test-'));
  const outputPath = path.join(tempDir, 'sessionArchive.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function session(id, overrides = {}) {
  return {
    id,
    source: 'claude',
    display: `Session ${id}`,
    timestamp: NOW,
    project: '/repo',
    projectName: 'repo',
    ...overrides,
  };
}

test('bulk archive offers stale and done sessions but protects pinned or running ones', async () => {
  const { selectBulkArchiveCandidates } = await importSessionArchive();
  const sessions = [
    session('fresh'),
    session('stale', { timestamp: NOW - 8 * DAY }),
    session('edge', { timestamp: NOW - 7 * DAY }),
    session('done', { taskStage: 'done' }),
    session('pinned-stale', { timestamp: NOW - 30 * DAY }),
    session('running-done', { taskStage: 'done' }),
  ];
  const protectedIds = new Set(['pinned-stale', 'running-done']);
  const { stale, done } = selectBulkArchiveCandidates(sessions, (item) => protectedIds.has(item.id), NOW);

  assert.deepEqual(stale.map((item) => item.id), ['stale', 'edge']);
  assert.deepEqual(done.map((item) => item.id), ['done']);
});

test('archived list search matches title, project, and label terms', async () => {
  const { filterArchivedSessions } = await importSessionArchive();
  const sessions = [
    session('a', { display: 'Fix login bug', projectName: 'web' }),
    session('b', { display: 'Release notes', projectName: 'cli', taskLabel: '发版' }),
  ];

  assert.equal(filterArchivedSessions(sessions, '  ').length, 2);
  assert.deepEqual(filterArchivedSessions(sessions, 'login WEB').map((item) => item.id), ['a']);
  assert.deepEqual(filterArchivedSessions(sessions, '发版').map((item) => item.id), ['b']);
  assert.equal(filterArchivedSessions(sessions, 'login cli').length, 0);
});
