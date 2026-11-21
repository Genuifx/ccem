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

test('uses Claude and Agy runtime permission mode when toggling plan in a live session', async () => {
  const { resolveWorkspaceRuntimePlanMode } = await importWorkspaceRuntimePlanMode();
  const { resolveComposerDispatch } = await importWorkspaceComposerDispatch();

  assert.equal(resolveWorkspaceRuntimePlanMode('claude', true), 'plan');
  assert.equal(resolveWorkspaceRuntimePlanMode('claude', false), null);
  assert.equal(resolveWorkspaceRuntimePlanMode('agy', true), 'plan');
  assert.equal(resolveWorkspaceRuntimePlanMode('agy', false), null);
  assert.equal(resolveWorkspaceRuntimePlanMode('codex', true), null);

  assert.deepEqual(resolveComposerDispatch({
    provider: 'agy',
    prompt: 'design the migration',
    permissionMode: 'dev',
    planModeEnabled: true,
  }), {
    prompt: 'design the migration',
    permMode: 'dev',
    runtimePermMode: 'plan',
  });
});

test('live agy plan mode toggle invokes setNativeSessionRuntimePermMode and rolls back on failure', async () => {
  const { resolveWorkspaceRuntimePlanMode } = await importWorkspaceRuntimePlanMode();
  const viewPath = path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const source = await fs.readFile(viewPath, 'utf8');
  const ast = ts.createSourceFile('WorkspaceNativeSessionView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callbackText = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node)
      && node.name.getText(ast) === 'applyRuntimePlanModeChange'
      && node.initializer
      && ts.isCallExpression(node.initializer)
    ) {
      callbackText = node.initializer.arguments[0].getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callbackText, 'applyRuntimePlanModeChange callback must be extracted from WorkspaceNativeSessionView.tsx');

  const transpiled = ts.transpileModule(`export const makeCallback = (deps) => {
    const {
      session,
      sessionRuntimePermMode,
      sessionDisplayPermMode,
      composerPlanModeEnabled,
      resolveWorkspaceRuntimePlanMode,
      setComposerPlanModeEnabled,
      setSessionRuntimePermMode,
      setNativeSessionRuntimePermMode,
      refreshSummary,
      toast,
      t,
    } = deps;
    return ${callbackText};
  };`, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-agy-plan-toggle-'));
  try {
    const modPath = path.join(tempDir, 'applyRuntimePlanModeChange.mjs');
    await fs.writeFile(modPath, transpiled.outputText, 'utf8');
    const { makeCallback } = await import(pathToFileURL(modPath).href);

    const calls = [];
    const refreshes = [];
    const errors = [];
    let currentRuntimeMode = 'dev';
    let currentPlanEnabled = false;
    let shouldFail = false;

    const run = (enabled) => makeCallback({
      session: { provider: 'agy', runtime_id: 'agy-rt-1' },
      sessionRuntimePermMode: currentRuntimeMode,
      sessionDisplayPermMode: 'dev',
      composerPlanModeEnabled: currentPlanEnabled,
      resolveWorkspaceRuntimePlanMode,
      setComposerPlanModeEnabled: (v) => { currentPlanEnabled = v; },
      setSessionRuntimePermMode: (v) => { currentRuntimeMode = v; },
      setNativeSessionRuntimePermMode: async (runtimeId, mode, attention) => {
        calls.push({ runtimeId, mode, attention });
        if (shouldFail) throw new Error('ACP mode switch failed');
      },
      refreshSummary: async (opts) => { refreshes.push(opts); },
      toast: { error: (msg) => errors.push(msg) },
      t: (key) => key,
    })(enabled);

    assert.equal(await run(true), true);
    assert.deepEqual(calls.at(-1), { runtimeId: 'agy-rt-1', mode: 'plan', attention: undefined });
    assert.equal(currentPlanEnabled, true);
    assert.equal(currentRuntimeMode, 'plan');
    assert.equal(refreshes.length, 1);

    assert.equal(await run(false), true);
    assert.deepEqual(calls.at(-1), { runtimeId: 'agy-rt-1', mode: null, attention: undefined });
    assert.equal(currentPlanEnabled, false);
    assert.equal(currentRuntimeMode, 'dev');
    assert.equal(refreshes.length, 2);

    shouldFail = true;
    assert.equal(await run(true), false);
    assert.equal(currentPlanEnabled, false);
    assert.equal(currentRuntimeMode, 'dev');
    assert.deepEqual(errors, ['workspace.nativeSettingsFailed']);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
