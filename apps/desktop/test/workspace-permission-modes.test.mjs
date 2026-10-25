import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWorkspaceModule(fileName) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-permission-test-'));
  return importTranspiledWorkspaceModule(fileName, tempDir);
}

async function importTranspiledWorkspaceModule(fileName, tempDir, rewriteImports = (source) => source) {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', fileName);
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const outputPath = path.join(tempDir, `${path.basename(fileName, '.ts')}.mjs`);
  await fs.writeFile(outputPath, rewriteImports(output.outputText), 'utf8');
  return import(pathToFileURL(outputPath).href);
}

async function importWorkspacePermissionModes() {
  return importWorkspaceModule('workspacePermissionModes.ts');
}

async function importWorkspaceComposerDispatch() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-permission-test-'));
  await importTranspiledWorkspaceModule('workspacePermissionModes.ts', tempDir);
  return importTranspiledWorkspaceModule(
    'workspaceComposerDispatch.ts',
    tempDir,
    (source) => source.replace(
      "from '@/components/workspace/workspacePermissionModes';",
      "from './workspacePermissionModes.mjs';",
    ),
  );
}

async function importWorkspaceRuntimePlanMode() {
  return importWorkspaceModule('workspaceRuntimePlanMode.ts');
}

test('keeps Claude plan runtime out of the permission dropdown', async () => {
  const { normalizeWorkspacePermissionModeName } = await importWorkspacePermissionModes();

  assert.equal(normalizeWorkspacePermissionModeName('plan', 'yolo'), 'yolo');
  assert.equal(normalizeWorkspacePermissionModeName('plan', 'plan'), 'dev');
  assert.notEqual(normalizeWorkspacePermissionModeName('plan'), 'readonly');
  assert.notEqual(normalizeWorkspacePermissionModeName('plan', 'yolo'), 'plan');
});

test('normalizes runtime permission aliases back to ccem permission names', async () => {
  const { normalizeWorkspacePermissionModeName } = await importWorkspacePermissionModes();

  assert.equal(normalizeWorkspacePermissionModeName('bypassPermissions'), 'yolo');
  assert.equal(normalizeWorkspacePermissionModeName('acceptEdits'), 'dev');
  assert.equal(normalizeWorkspacePermissionModeName('manual'), 'dev');
  assert.equal(normalizeWorkspacePermissionModeName('read-only'), 'readonly');
  assert.equal(normalizeWorkspacePermissionModeName('auto'), 'auto');
  assert.equal(normalizeWorkspacePermissionModeName('ci'), 'safe');
  assert.equal(normalizeWorkspacePermissionModeName('audit'), 'readonly');
  assert.equal(normalizeWorkspacePermissionModeName('unknown-mode'), 'dev');
});

test('starts Claude plan mode with a separate runtime permission', async () => {
  const { resolveComposerDispatch } = await importWorkspaceComposerDispatch();

  assert.deepEqual(resolveComposerDispatch({
    provider: 'claude',
    prompt: '  draft a plan  ',
    permissionMode: 'yolo',
    planModeEnabled: true,
  }), {
    prompt: 'draft a plan',
    permMode: 'yolo',
    runtimePermMode: 'plan',
  });
});

test('sanitizes stale plan permission before creating native sessions', async () => {
  const { resolveComposerDispatch } = await importWorkspaceComposerDispatch();

  assert.deepEqual(resolveComposerDispatch({
    provider: 'claude',
    prompt: 'draft a plan',
    permissionMode: 'plan',
    planModeEnabled: true,
  }), {
    prompt: 'draft a plan',
    permMode: 'dev',
    runtimePermMode: 'plan',
  });
});

test('keeps Codex plan as prompt text without changing runtime permission', async () => {
  const { resolveComposerDispatch } = await importWorkspaceComposerDispatch();

  assert.deepEqual(resolveComposerDispatch({
    provider: 'codex',
    prompt: 'implement it',
    permissionMode: 'dev',
    planModeEnabled: true,
  }), {
    prompt: '/plan implement it',
    permMode: 'dev',
    runtimePermMode: null,
  });
});

test('uses Claude runtime permission mode when toggling plan in a live session', async () => {
  const { resolveWorkspaceRuntimePlanMode } = await importWorkspaceRuntimePlanMode();

  assert.equal(resolveWorkspaceRuntimePlanMode('claude', true), 'plan');
  assert.equal(resolveWorkspaceRuntimePlanMode('claude', false), null);
  assert.equal(resolveWorkspaceRuntimePlanMode('codex', true), null);
});
