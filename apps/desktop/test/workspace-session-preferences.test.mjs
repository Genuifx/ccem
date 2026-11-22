import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWorkspaceSessionPreferences() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceSessionPreferences.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-preferences-test-'));
  const outputPath = path.join(tempDir, 'workspaceSessionPreferences.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('keeps history composer permission and effort per selected session', async () => {
  const {
    updateHistorySessionPreference,
    resolveHistorySessionControls,
  } = await importWorkspaceSessionPreferences();

  let preferences = {};
  preferences = updateHistorySessionPreference(preferences, 'claude:session-a', {
    permMode: 'yolo',
    effort: 'max',
  });

  const sessionA = {
    id: 'session-a',
    source: 'claude',
    envName: 'DeepSeek',
  };
  const sessionB = {
    id: 'session-b',
    source: 'claude',
    envName: 'Kimi',
  };

  assert.deepEqual(resolveHistorySessionControls({
    session: sessionB,
    preferences,
    currentEnv: 'Default',
    defaultPermMode: 'dev',
  }), {
    envName: 'Kimi',
    permMode: 'dev',
    effort: 'max',
  });

  assert.deepEqual(resolveHistorySessionControls({
    session: sessionA,
    preferences,
    currentEnv: 'Default',
    defaultPermMode: 'dev',
  }), {
    envName: 'DeepSeek',
    permMode: 'yolo',
    effort: 'max',
  });
});

test('normalizes unsupported effort levels for the selected provider and clamps to per-model efforts', async () => {
  const {
    normalizeEffortForProvider,
    clampEffortToSupportedLevels,
    updateHistorySessionPreference,
    resolveHistorySessionControls,
  } = await importWorkspaceSessionPreferences();

  assert.equal(normalizeEffortForProvider('max', 'codex'), 'high');
  assert.equal(normalizeEffortForProvider('max', 'claude'), 'max');
  assert.equal(normalizeEffortForProvider(null, 'claude'), 'max');
  assert.equal(normalizeEffortForProvider(null, 'agy'), 'high');
  assert.equal(normalizeEffortForProvider('minimal', 'agy'), 'high');
  assert.equal(normalizeEffortForProvider('max', 'agy'), 'xhigh');
  assert.equal(normalizeEffortForProvider('xhigh', 'agy'), 'xhigh');

  assert.equal(clampEffortToSupportedLevels('xhigh', ['low', 'medium', 'high']), 'high');
  assert.equal(clampEffortToSupportedLevels('max', ['low', 'medium', 'high', 'xhigh']), 'xhigh');
  assert.equal(clampEffortToSupportedLevels('minimal', ['low', 'medium', 'high']), 'low');
  assert.equal(clampEffortToSupportedLevels('medium', ['low', 'medium', 'high']), 'medium');

  const prefs = updateHistorySessionPreference({}, 'agy:conv-1', {
    model: 'claude-opus-5-5',
    effort: 'high',
  });
  assert.deepEqual(resolveHistorySessionControls({
    session: { id: 'conv-1', source: 'agy', envName: 'Antigravity' },
    preferences: prefs,
    currentEnv: 'Default',
    defaultPermMode: 'dev',
    defaultModel: 'gemini-4-neon',
  }), {
    envName: 'Antigravity',
    permMode: 'dev',
    effort: 'high',
    model: 'claude-opus-5-5',
  });
});
