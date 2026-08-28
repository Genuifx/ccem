import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function readSource(...parts) {
  return fs.readFile(path.join(desktopDir, ...parts), 'utf8');
}

test('Claude background task panel exposes activity, terminal history, and confirmed single-task stop', async () => {
  const panel = await readSource(
    'src',
    'components',
    'workspace',
    'WorkspaceBackgroundTasksPopover.tsx',
  );

  assert.match(panel, /data-ccem-background-tasks-trigger/);
  assert.match(panel, /data-ccem-background-tasks-attention/);
  assert.match(panel, /data-ccem-background-tasks-popover/);
  assert.match(panel, /data-ccem-background-tasks-dismiss/);
  assert.match(panel, /data-ccem-background-task-stop-dialog/);
  assert.match(panel, /canStopBackgroundTask\(task\)/);
  assert.match(panel, /activeTasks\.find\(\(task\) => task\.task_id === stopTargetId\)/);
  assert.match(panel, /!canStopBackgroundTask\(stopTarget\)/);
  assert.match(panel, /await onStopTask\(stopTarget\.task_id\)/);
  assert.match(panel, /task\.output_file/);
  assert.doesNotMatch(panel, /readFile|tail\s*\(/i);
});

test('Workspace keeps foreground composition independent and guards task-destructive actions', async () => {
  const workspace = await readSource(
    'src',
    'components',
    'workspace',
    'WorkspaceNativeSessionView.tsx',
  );

  const canSendBlock = workspace.match(/const canSend =[\s\S]*?;\n  const canShowFileRestorePoints/)?.[0] ?? '';
  assert.doesNotMatch(canSendBlock, /activeBackgroundTaskCount/);
  assert.match(workspace, /activeBackgroundTaskCount === 0/);
  assert.match(workspace, /data-ccem-background-task-risk-dialog/);
  assert.match(workspace, /performEnvChange\(action\.envName\)/);
  assert.match(workspace, /performEffortChange\(action\.effort, force\)/);
  assert.match(workspace, /performHandoff\(true\)/);
  assert.match(workspace, /disabled=\{isHandingOff \|\| isHandoffPending \|\| isProcessingTurn\}/);
  assert.match(workspace, /attentionState\.permissions\.some\([\s\S]*?!request\.backgroundTaskId/);
  assert.match(workspace, /const hasBackgroundTaskPanel = session\.provider === 'claude'/);
  assert.match(workspace, /&& !bgTasksDismissed/);
  assert.match(workspace, /if \(backgroundTaskModel\.active\.length > 0\) setBgTasksDismissed\(false\)/);
  assert.match(workspace, /onDismiss=\{\(\) => setBgTasksDismissed\(true\)\}/);
  assert.match(workspace, /hasAttentionPanel = attentionState\.permissions\.length > 0[\s\S]*?\|\| hasBackgroundTaskPanel/);

  const backgroundTaskPanelIndex = workspace.indexOf('<WorkspaceBackgroundTasksPopover');
  const aboveComposerIndex = workspace.indexOf('aboveComposer=');
  const composerControlsIndex = workspace.indexOf('controls={(', aboveComposerIndex);
  const secondaryActionsIndex = workspace.indexOf('secondaryActions={(', composerControlsIndex);
  assert.ok(backgroundTaskPanelIndex > aboveComposerIndex);
  assert.ok(backgroundTaskPanelIndex < composerControlsIndex);
  assert.ok(secondaryActionsIndex > backgroundTaskPanelIndex);
  assert.equal(workspace.match(/<WorkspaceBackgroundTasksPopover/g)?.length, 1);
});

test('Workspace environment changes are force-only while effort changes may still defer', async () => {
  const workspace = await readSource(
    'src',
    'components',
    'workspace',
    'WorkspaceNativeSessionView.tsx',
  );
  const envChangeBlock = workspace.match(
    /const performEnvChange = useCallback[\s\S]*?const handlePermModeChange/,
  )?.[0] ?? '';
  const riskActionBlock = workspace.match(
    /const applyPendingBackgroundTaskRiskAction = useCallback[\s\S]*?const handleRestoreFileCheckpoint/,
  )?.[0] ?? '';
  const riskDialogBlock = workspace.match(
    /data-ccem-background-task-risk-dialog[\s\S]*?<\/Dialog>/,
  )?.[0] ?? '';

  assert.match(
    envChangeBlock,
    /updateNativeSessionSettings\([\s\S]*?envName,[\s\S]*?undefined,[\s\S]*?undefined,[\s\S]*?true,/,
    'every environment selection must request a forced retained-query restart',
  );
  assert.doesNotMatch(
    envChangeBlock,
    /performEnvChange = useCallback\(\(envName: string, forceRestart/,
    'callers must not be able to downgrade an environment switch to deferred mode',
  );
  assert.match(riskActionBlock, /if \(!force && action\.kind === 'effort'\)/);
  assert.match(riskActionBlock, /performEnvChange\(action\.envName\)/);
  assert.match(
    riskDialogBlock,
    /pendingBackgroundTaskRiskAction\?\.kind === 'effort'/,
    'only effort changes retain the wait-for-background-tasks action',
  );
});

test('app quit and restart share the background-task confirmation guard', async () => {
  const guard = await readSource('src', 'components', 'NativeBackgroundTaskAppGuard.tsx');
  const updater = await readSource(
    'src',
    'components',
    'app-update',
    'AppUpdateProvider.tsx',
  );
  const app = await readSource('src', 'App.tsx');

  assert.match(guard, /list_native_sessions/);
  assert.match(guard, /native-background-task-app-action/);
  assert.match(guard, /data-ccem-background-task-app-guard/);
  assert.match(guard, /setTaskCount\(count\);\s*setPendingAction\(action\);/);
  assert.match(guard, /taskCount > 0[\s\S]*nativeRuntimeUnsafeActionWarningTitle/);
  assert.match(guard, /execute\(pendingAction, true\)/);
  assert.match(updater, /await requestRestart\(\)/);
  assert.match(app, /'meta\+q': \(\) => \{ void requestQuit\(\); \}/);
});
