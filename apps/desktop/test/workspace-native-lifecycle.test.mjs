import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importNativeSessionProjection() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'workspace',
    'workspaceNativeSessionProjection.ts',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-native-lifecycle-test-'));
  const outputPath = path.join(tempDir, 'workspaceNativeSessionProjection.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('a present coordinator projection fully replaces the legacy processing heuristic', async () => {
  const { selectNativeSessionProcessing } = await importNativeSessionProjection();
  let fallbackCalls = 0;
  const legacyProcessing = () => {
    fallbackCalls += 1;
    return true;
  };

  assert.equal(
    selectNativeSessionProcessing({ active_command_id: 'command-1' }, legacyProcessing),
    true,
    'an active coordinator command owns the foreground',
  );
  assert.equal(
    selectNativeSessionProcessing({ active_command_id: null }, legacyProcessing),
    false,
    'an idle coordinator must override a stale processing heuristic',
  );
  assert.equal(fallbackCalls, 0, 'legacy inference must not run when projection exists');
});

test('only runtimes without a coordinator projection use the compatibility fallback', async () => {
  const { selectNativeSessionProcessing } = await importNativeSessionProjection();
  let fallbackCalls = 0;
  const fallback = () => {
    fallbackCalls += 1;
    return fallbackCalls === 1;
  };

  assert.equal(selectNativeSessionProcessing(undefined, fallback), true);
  assert.equal(selectNativeSessionProcessing(null, fallback), false);
  assert.equal(fallbackCalls, 2);
});

test('Plan approval uses one backend transaction and updates optimistic mode only after success', async () => {
  const source = await fs.readFile(
    path.join(
      desktopDir,
      'src',
      'components',
      'workspace',
      'WorkspaceNativeSessionView.tsx',
    ),
    'utf8',
  );
  const planReplyBranch = source.indexOf("} else if (payload.kind === 'plan_exit')");
  const backendReply = source.indexOf('await respondNativeSessionPrompt', planReplyBranch);
  const optimisticExit = source.indexOf('if (exitsPlanModeForPrompt)', backendReply);
  const interactivePromptEntry = source.slice(
    source.indexOf('const promptEntry: LocalUserPrompt = {', source.indexOf('const sendInteractivePromptReply')),
    source.indexOf('const exitsPlanModeForPrompt', source.indexOf('const sendInteractivePromptReply')),
  );
  assert.ok(planReplyBranch >= 0 && backendReply > planReplyBranch);
  assert.ok(optimisticExit > backendReply, 'renderer mode changes only after backend success');
  assert.match(
    interactivePromptEntry,
    /deferUntilPersisted: true,/,
    'interactive and Plan replies must not anchor before their persisted user_prompt',
  );
  assert.doesNotMatch(
    source.slice(planReplyBranch, backendReply),
    /applyRuntimePlanModeChange/,
    'the renderer must not split permission and reply into two IPC calls',
  );

  const rustSource = await fs.readFile(
    path.join(desktopDir, 'src-tauri', 'src', 'native_runtime.rs'),
    'utf8',
  );
  const responseTransaction = rustSource.slice(
    rustSource.indexOf('pub fn respond_to_prompt('),
    rustSource.indexOf('fn active_background_tasks('),
  );
  assert.match(responseTransaction, /update_session_runtime_perm_mode_under_transition/);
  assert.match(responseTransaction, /wait_for_interactive_ack/);
});
